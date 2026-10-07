/**
 * Pictures the owner attaches to a message (v2 plan §3): checked here again (type by the real header bytes, size,
 * count), saved with the chat, and turned into the content blocks the AI receives.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const TYPES = {
  'image/png': { ext: 'png', is: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', is: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', is: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
const BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const FILE = /^[A-Za-z0-9-]+-\d\.(png|jpg|webp)$/;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {unknown} list  [{ mediaType, data (base64) }] as the backend sends it
 * @returns {{ mediaType: string, data: string, ext: string, bytes: Buffer }[]}
 */
export function checkImages(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ImageError('image_invalid', 'The pictures could not be read.');
  if (list.length > MAX_IMAGES) throw new ImageError('too_many_images', `You can attach up to ${MAX_IMAGES} pictures to one message.`);
  return list.map((image) => {
    const type = TYPES[image?.mediaType];
    if (!type) throw new ImageError('image_type', 'Only PNG, JPEG or WebP pictures can be attached.');
    if (typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new ImageError('image_invalid', 'The picture could not be read.');
    // base64 is 4/3 of the bytes: refuse before decoding a huge one
    if (image.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new ImageError('image_too_large', 'Each picture can be up to 2 MB.');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError('image_too_large', 'Each picture can be up to 2 MB.');
    if (!type.is(bytes)) throw new ImageError('image_type', 'That file is not a real PNG, JPEG or WebP picture.');
    return { mediaType: image.mediaType, data: image.data, ext: type.ext, bytes };
  });
}

const dirOf = (dataDir, storeId, chatId) => path.join(dataDir, 'uploads', storeId, chatId);

/** Saves checked pictures; answers what the message keeps: [{ file, mediaType }]. */
export function saveImages(dataDir, storeId, chatId, messageId, images) {
  const dir = dirOf(dataDir, storeId, chatId);
  if (images.length) fs.mkdirSync(dir, { recursive: true });
  return images.map((image, i) => {
    const file = `${messageId}-${i + 1}.${image.ext}`;
    fs.writeFileSync(path.join(dir, file), image.bytes);
    return { file, mediaType: image.mediaType };
  });
}

/** A saved picture for the admin page (null when the name is not one of ours or the file is gone). */
export function readImage(dataDir, storeId, chatId, file) {
  if (!FILE.test(String(file))) return null;
  try {
    return { bytes: fs.readFileSync(path.join(dirOf(dataDir, storeId, chatId), file)), mediaType: BY_EXT[file.split('.').pop()] };
  } catch {
    return null;
  }
}

/** Loads saved pictures again as AI input (a plan waiting for OK keeps its pictures). */
export function loadImages(dataDir, storeId, chatId, refs) {
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const image = readImage(dataDir, storeId, chatId, ref?.file);
    if (image) out.push({ mediaType: image.mediaType, data: image.bytes.toString('base64') });
  }
  return out;
}

/**
 * The prompt for the Agent SDK: plain text, or (with pictures) a one-message stream whose content is the picture
 * blocks followed by the text (streaming input, which is how the SDK takes images).
 */
export function promptWithImages(text, images = []) {
  if (!images.length) return text;
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }],
      },
      parent_tool_use_id: null,
    };
  })();
}

/** The same as Messages API content, for the API-key triage client. */
export function contentWithImages(text, images = []) {
  if (!images.length) return text;
  return [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }];
}
