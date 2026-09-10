import fs from 'node:fs';
import path from 'node:path';

import { PRODUCT_NAME } from './brand.generated.mjs';

export const assertUpdaterCapability = ({
  appImagePath = process.env.APPIMAGE || '',
  platform = process.platform,
  packaged,
  access = fs.accessSync,
  stat = fs.statSync,
} = {}) => {
  if (platform !== 'linux' || !packaged) return;

  if (!appImagePath) {
    throw new Error(
      `Updates require the packaged Linux AppImage. Start ${PRODUCT_NAME} from its .AppImage file, not an extracted or repackaged copy.`,
    );
  }
  if (!path.isAbsolute(appImagePath)) {
    throw new Error(`Updates require APPIMAGE to be an absolute path, got: ${appImagePath}`);
  }

  try {
    if (!stat(appImagePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`The running AppImage cannot be found at ${appImagePath}. Start ${PRODUCT_NAME} from a valid .AppImage file.`);
  }

  try {
    access(appImagePath, fs.constants.W_OK);
  } catch {
    throw new Error(
      `The AppImage is not writable at ${appImagePath}. Move it to a writable location or grant write permission before updating.`,
    );
  }
};
