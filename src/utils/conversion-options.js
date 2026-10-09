import { OUTPUT_FORMATS } from './output-formats.js';
import { ValidationError } from './errors.js';

export function conversionInfo(metadata) {
  const streams = metadata.streams ?? [];
  const video = streams.find(
    stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic
  );
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  const audio = audioStreams.find(stream => stream.disposition?.default) ?? audioStreams[0];
  const hasAudio = Boolean(audio);
  if (!video && !hasAudio) throw new ValidationError('that file has no usable audio or video.');
  const demuxer = metadata.format?.format_name ?? '';
  const kind = !video
    ? 'audio'
    : ['gif', 'apng'].includes(demuxer)
      ? 'animation'
      : /(?:_pipe|image2)/.test(demuxer)
        ? 'image'
        : 'video';
  const duration = Number(metadata.format?.duration);
  return {
    kind,
    demuxer,
    hasAudio,
    videoIndex: video?.index,
    audioIndex: audio?.index,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

export function compatibleFormats(info) {
  return ['gif', ...Object.keys(OUTPUT_FORMATS)].filter(format => {
    const kind = format === 'gif' ? 'image' : OUTPUT_FORMATS[format].kind;
    if (kind === 'audio') return info.hasAudio;
    if (info.kind === 'audio') return false;
    return kind !== 'video' || info.kind !== 'image';
  });
}

export function conversionTrim(info, times = {}) {
  const trim = { startTime: times?.startTime ?? null, duration: times?.duration ?? null };
  if (trim.duration !== null && trim.duration <= 0)
    throw new ValidationError('the end time has to be after the start time.');
  if (info.kind === 'image' && (trim.startTime !== null || trim.duration !== null)) {
    throw new ValidationError('start and end times do not apply to a still image.');
  }
  if (
    info.duration !== null &&
    ((trim.startTime ?? 0) >= info.duration ||
      (trim.startTime ?? 0) + (trim.duration ?? 0) > info.duration + 0.05)
  ) {
    throw new ValidationError('the requested timeframe is outside the length of that file.');
  }
  return trim;
}
