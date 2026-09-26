import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('./.env') });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export class CloudinaryService {
  // Upload from buffer (used with multer memoryStorage)
  static async uploadBuffer(buffer, folder = 'ushers') {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'image' },
        (error, result) => {
          if (error) return reject(error);
          resolve({ secure_url: result.secure_url, public_id: result.public_id });
        }
      );
      stream.end(buffer);
    });
  }

  // Delete image by public_id
  static async deleteImage(public_id) {
    if (!public_id || public_id === 'default_avatar') return;
    await cloudinary.uploader.destroy(public_id);
  }
}

export default cloudinary;
