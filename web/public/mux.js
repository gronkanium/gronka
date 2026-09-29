const BASE = '/_libav';

// Stream copy only: both parts go in as lazily read blobs, one mp4 (or webm) comes out.
export async function remux(video, audio, filename) {
  const { default: libavjs } = await import(`${BASE}/libav-6.8.7.1-remux-cli.mjs`);
  const libav = await libavjs.LibAV({ base: BASE, nothreads: true });
  const webm = /webm/.test(video.type + audio.type) || /\.webm$/i.test(filename);
  const out = webm ? 'out.webm' : 'out.mp4';
  try {
    await libav.mkreadaheadfile('v', video);
    await libav.mkreadaheadfile('a', audio);
    const code = await libav.ffmpeg(
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-i',
      'v',
      '-i',
      'a',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      ...(webm ? ['-f', 'webm'] : ['-movflags', '+faststart', '-f', 'mp4']),
      out
    );
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    const data = await libav.readFile(out);
    return new Blob([data], { type: webm ? 'video/webm' : 'video/mp4' });
  } finally {
    libav.terminate();
  }
}
