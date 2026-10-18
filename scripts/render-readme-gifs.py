"""SPDX-License-Identifier: MIT
Build the original rectangular README GIFs from the final 4K master.
Requires Pillow and imageio-ffmpeg. Production footage stays local.
"""
from pathlib import Path
import hashlib,json,subprocess
from PIL import Image,ImageChops
import imageio_ffmpeg

root=Path(__file__).resolve().parents[1]
source=root/'product-launch/export/export-4k.mp4'
output=root/'docs/media'
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
expected=sha(source)
reader=imageio_ffmpeg.read_frames(str(source));metadata=next(reader);reader.close()
assert tuple(metadata['size'])==(3840,2160) and metadata['fps']==60
assert abs(metadata['duration']-74)<.1
clips=[
 {'file':'mimo-intro.gif','ranges':[(.1,14.6),(15.05,8.45)],'shows':['Greeting and permissions','Terminal','GitHub activity','Stripe balance count-up']},
 {'file':'mimo-coding.gif','ranges':[(2.8,12)],'shows':['Permissions and terminal']},
]
report={'source':'product-launch/export/export-4k.mp4','source_sha256':expected,'source_description':'Final Mimo Signature master: 3840x2160, 60 fps, 74 seconds. Product footage is decoded from this export.','presentation':'Original 960 x 528 rectangular crop. The main loop omits only the appended triple-tap scene.','encoder':'FFmpeg with lossless Pillow frame optimization','fps':15,'max_colors':192,'clips':[]}
for clip in clips:
    file=output/clip['file'];duration=sum(length for _,length in clip['ranges'])
    encoded=root/'windows/target/readme-gifs'/clip['file']
    encoded.parent.mkdir(parents=True,exist_ok=True)
    crop={'x':520,'y':540,'width':2800,'height':1540}
    command=[imageio_ffmpeg.get_ffmpeg_exe(),'-v','error']
    filters=[]
    for index,(start,length) in enumerate(clip['ranges']):
        command+=['-ss',str(start),'-t',str(length),'-i',str(source)]
        filters.append(f"[{index}:v]crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']},fps=15,scale=960:528:flags=lanczos,setpts=PTS-STARTPTS[v{index}]")
    joined=''.join(f'[v{index}]' for index in range(len(clip['ranges'])))
    filters.append(joined+f"concat=n={len(clip['ranges'])}:v=1:a=0,split[a][b]")
    filters.append('[a]palettegen=max_colors=192:stats_mode=diff[p]')
    filters.append('[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle')
    subprocess.run(command+['-filter_complex',';'.join(filters),'-an','-t',str(duration),'-loop','0','-y',str(encoded)],check=True)
    frames=[];durations=[]
    with Image.open(encoded) as image:
        for index in range(image.n_frames):
            image.seek(index)
            rgb=image.convert('RGB')
            frame=rgb.quantize(colors=256,dither=Image.Dither.NONE)
            assert ImageChops.difference(rgb,frame.convert('RGB')).getbbox() is None,'GIF optimization changed a color'
            frame.info.clear();frames.append(frame)
            durations.append(image.info.get('duration',0))
    frames[0].save(file,save_all=True,append_images=frames[1:],optimize=True,disposal=1,duration=durations,loop=0)
    with Image.open(file) as image:
        total=0
        for frame in range(image.n_frames):image.seek(frame);image.load();total+=image.info.get('duration',0)
        item={'file':clip['file'],'source_ranges':[{'start_seconds':start,'duration_seconds':length} for start,length in clip['ranges']],'shows':clip['shows'],'source_duration_seconds':duration,'source_crop':crop,'width':image.width,'height':image.height,'frames':image.n_frames,'decoded_duration_ms':total,'loop':image.info.get('loop'),'bytes':file.stat().st_size,'sha256':sha(file)}
    assert abs(total/1000-duration)<.15 and item['loop']==0
    assert (image.width,image.height)==(960,528)
    report['clips'].append(item)
    print(json.dumps(item),flush=True)
assert sha(source)==expected,'Source changed while creating GIFs'
(output/'previews.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
