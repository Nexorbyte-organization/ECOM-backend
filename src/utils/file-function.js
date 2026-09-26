import fs from 'fs';
import path from 'path';

export class FileService {
  static deleteFile(filePath) {
    try {
      const fullpath = path.resolve(filePath);
      if (fs.existsSync(fullpath)) {
        fs.unlinkSync(fullpath);
      }
    } catch {
      // Silently ignore — file may already be deleted or never existed
    }
  }
}
