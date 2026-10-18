// SPDX-License-Identifier: MIT
#[cfg(test)]
use crate::claude::ChatReply;
use std::future::Future;

/// Serialize chat turns and cancel work when keys or the conversation change.
pub struct ChatRequests {
    epoch: tokio::sync::watch::Sender<u64>,
    turn: tokio::sync::Mutex<()>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn cancelling_chat_drops_pending_work_and_releases_the_turn() {
        struct Cleanup(Arc<AtomicBool>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let requests = Arc::new(ChatRequests::default());
            let released = Arc::new(AtomicBool::new(false));
            let cleanup = Cleanup(released.clone());
            let cancel = requests.clone();
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                cancel.cancel();
            });
            let result = requests
                .run(async move {
                    let _cleanup = cleanup;
                    std::future::pending::<Result<ChatReply, String>>().await
                })
                .await;
            assert!(result.is_err());
            assert!(released.load(Ordering::Relaxed));
            assert!(requests
                .run(async {
                    Ok(ChatReply {
                        text: "Next turn".into(),
                    })
                })
                .await
                .is_ok());
        });
    }

    #[test]
    fn a_cancelled_ticket_never_starts_a_request_captured_before_a_provider_change() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let requests = ChatRequests::default();
            let ticket = requests.ticket();
            requests.cancel();
            let started = AtomicBool::new(false);
            let result = requests
                .run_at(ticket, async {
                    started.store(true, Ordering::Relaxed);
                    Ok(ChatReply {
                        text: "Must not send".into(),
                    })
                })
                .await;
            assert!(result.is_err());
            assert!(!started.load(Ordering::Relaxed));
        });
    }
}

impl Default for ChatRequests {
    fn default() -> Self {
        Self {
            epoch: tokio::sync::watch::channel(0).0,
            turn: tokio::sync::Mutex::new(()),
        }
    }
}

impl ChatRequests {
    pub fn ticket(&self) -> u64 {
        *self.epoch.borrow()
    }
    pub fn cancel(&self) {
        self.epoch
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }

    #[cfg(test)]
    pub async fn run(
        &self,
        work: impl Future<Output = Result<ChatReply, String>>,
    ) -> Result<ChatReply, String> {
        self.run_at(self.ticket(), work).await
    }

    pub async fn run_at<T>(
        &self,
        ticket: u64,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut epoch = self.epoch.subscribe();
        if *epoch.borrow() != ticket {
            return Err("The conversation changed. Send your message again.".into());
        }
        use std::task::Poll;
        let mut changed = std::pin::pin!(epoch.changed());
        let mut work = std::pin::pin!(async {
            let _turn = self.turn.lock().await;
            work.await
        });
        std::future::poll_fn(|cx| {
            if changed.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(
                    "The conversation changed. Send your message again.".into()
                ));
            }
            work.as_mut().poll(cx)
        })
        .await
    }
}
