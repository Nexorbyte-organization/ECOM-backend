import test from 'node:test';
import assert from 'node:assert/strict';
import cloudinary, { CloudinaryService } from '../src/utils/cloudinary.js';
import { UploadFolders } from '../src/utils/uploadFolders.js';

test('uploads use the approved ECOM folders and preserve Cloudinary image references', async (t) => {
  const folders = [
    [UploadFolders.profilePicture('usher-1'), 'ECOM/ushers/usher-1/profile-picture'],
    [UploadFolders.portfolio('usher-1'), 'ECOM/ushers/usher-1/portfolio'],
    [UploadFolders.organizationLogo('owner-1'), 'ECOM/organization/owner-1/logo'],
    [UploadFolders.eventPhoto('owner-1', 'event-1'), 'ECOM/organization/owner-1/events/event-1/photos'],
  ];
  const buffer = Buffer.from('image');
  let expectedFolder;
  t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.deepEqual(options, { folder: expectedFolder, resource_type: 'image' });
    return { end(data) {
      assert.equal(data, buffer);
      callback(null, { secure_url: 'https://example.com/image.jpg', public_id: `${options.folder}/image-1` });
    } };
  });

  for (const [folder, expected] of folders) {
    expectedFolder = expected;
    const image = await CloudinaryService.uploadBuffer(buffer, folder);
    assert.deepEqual(image, { secure_url: 'https://example.com/image.jpg', public_id: `${expected}/image-1` });
  }
});

test('user and event uploads remain separated', () => {
  assert.notEqual(UploadFolders.portfolio('usher-1'), UploadFolders.portfolio('usher-2'));
  assert.notEqual(UploadFolders.eventPhoto('owner-1', 'event-1'), UploadFolders.eventPhoto('owner-2', 'event-1'));
  assert.notEqual(UploadFolders.eventPhoto('owner-1', 'event-1'), UploadFolders.eventPhoto('owner-1', 'event-2'));
});

test('deletion supports both legacy and ECOM public IDs while skipping the default avatar', async (t) => {
  const deleted = [];
  t.mock.method(cloudinary.uploader, 'destroy', async (publicId) => deleted.push(publicId));
  await CloudinaryService.deleteImage('ushers/profiles/old-image');
  await CloudinaryService.deleteImage('ECOM/ushers/usher-1/profile-picture/new-image');
  await CloudinaryService.deleteImage('default_avatar');
  await CloudinaryService.deleteImage(null);
  assert.deepEqual(deleted, ['ushers/profiles/old-image', 'ECOM/ushers/usher-1/profile-picture/new-image']);
});
