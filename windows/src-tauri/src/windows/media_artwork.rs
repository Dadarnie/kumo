// SPDX-License-Identifier: MIT
//! Bounded, asynchronous thumbnail reads owned by the media MTA worker.
use std::sync::Arc;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD, Engine};
use windows::core::{Interface, Result as WinResult};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamWithContentType};
use windows_future::IAsyncOperation;

use super::{MediaProperties, Pending, ReadVersion, Signals};
use crate::media_player::MediaArtwork;

pub(super) const MAX_ARTWORK_BYTES: u64 = 4 * 1024 * 1024;

struct Stream(IRandomAccessStreamWithContentType);
impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}
struct Reader(DataReader);
impl Drop for Reader {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}
enum Stage {
    Opening(Pending<IRandomAccessStreamWithContentType>),
    Loading {
        pending: Pending<u32>,
        reader: Reader,
        _stream: Stream,
        size: u32,
    },
}
pub(super) struct ArtworkRead {
    pub version: ReadVersion,
    stage: Stage,
}
impl ArtworkRead {
    pub fn new(
        properties: &MediaProperties,
        signals: &Arc<Signals>,
        version: ReadVersion,
    ) -> WinResult<Option<Self>> {
        let thumbnail = match properties.Thumbnail() {
            Ok(thumbnail) => thumbnail,
            Err(error) if error.code() == windows::core::Error::empty().code() => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(Some(Self {
            version,
            stage: Stage::Opening(Pending::new(thumbnail.OpenReadAsync()?, signals.clone())?),
        }))
    }
    pub fn deadline(&self) -> Instant {
        match &self.stage {
            Stage::Opening(pending) => pending.deadline,
            Stage::Loading { pending, .. } => pending.deadline,
        }
    }
    pub fn advance(
        &mut self,
        now: Instant,
        signals: &Arc<Signals>,
    ) -> Option<Result<Option<Arc<MediaArtwork>>, String>> {
        match &self.stage {
            Stage::Opening(pending) => {
                let result = pending.result(now)?;
                let next = (|| -> Result<Stage, String> {
                    let stream = Stream(result?);
                    let size = stream.0.Size().map_err(|error| error.to_string())?;
                    if size == 0 || size > MAX_ARTWORK_BYTES {
                        return Err("Artwork is empty or exceeds the size limit".into());
                    }
                    let reader = Reader(
                        DataReader::CreateDataReader(
                            &stream
                                .0
                                .GetInputStreamAt(0)
                                .map_err(|error| error.to_string())?,
                        )
                        .map_err(|error| error.to_string())?,
                    );
                    let operation = reader
                        .0
                        .LoadAsync(size as u32)
                        .and_then(|operation| operation.cast::<IAsyncOperation<u32>>())
                        .map_err(|error| error.to_string())?;
                    let pending = Pending::new(operation, signals.clone())
                        .map_err(|error| error.to_string())?;
                    Ok(Stage::Loading {
                        pending,
                        reader,
                        _stream: stream,
                        size: size as u32,
                    })
                })();
                match next {
                    Ok(stage) => {
                        self.stage = stage;
                        None
                    }
                    Err(error) => Some(Err(error)),
                }
            }
            Stage::Loading {
                pending,
                reader,
                size,
                ..
            } => {
                let result = pending.result(now)?;
                Some((|| {
                    if result? != *size {
                        return Err("Incomplete artwork read".into());
                    }
                    let mut bytes = vec![0; *size as usize];
                    reader
                        .0
                        .ReadBytes(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    Ok(artwork_from_bytes(&bytes).map(Arc::new))
                })())
            }
        }
    }
}

fn artwork_from_bytes(bytes: &[u8]) -> Option<MediaArtwork> {
    if bytes.len() as u64 > MAX_ARTWORK_BYTES {
        return None;
    }
    // Only raster formats become data URLs. SVG/HTML and arbitrary content are
    // never handed to the webview as artwork; unknown formats use the fallback.
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return None;
    };
    Some(MediaArtwork {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_artwork_accepts_bounded_raster_images_and_rejects_other_content() {
        assert!(artwork_from_bytes(b"\x89PNG\r\n\x1a\nexample")
            .unwrap()
            .data_url
            .starts_with("data:image/png;base64,"));
        assert!(artwork_from_bytes(b"\xff\xd8\xffexample")
            .unwrap()
            .data_url
            .starts_with("data:image/jpeg;base64,"));
        assert!(artwork_from_bytes(b"<svg></svg>").is_none());
        assert!(artwork_from_bytes(&[]).is_none());
        assert!(artwork_from_bytes(&vec![0; MAX_ARTWORK_BYTES as usize + 1]).is_none());
    }
}
