import multer from 'multer';
import { AppError } from './appError.js';

const fileValidation = {
  image: ['image/jpg', 'image/jpeg', 'image/png'],
  file: ['application/pdf', 'application/msword'],
  video: ['video/mp4'],
};

export class MulterService {
  static cloudUpload({ allowFile = fileValidation.image } = {}) {
    const storage = multer.memoryStorage();

    const fileFilter = (req, file, cb) => {
      if (allowFile.includes(file.mimetype)) return cb(null, true);
      cb(new AppError('Only JPEG and PNG images are allowed', 400), false);
    };

    return multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB max
  }
}
