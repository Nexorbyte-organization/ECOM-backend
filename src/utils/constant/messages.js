const genrateMessage = (entity) => ({
  alreadyExist: `${entity} already exist`,
  notfound: `${entity} not found`,
  failtocreate: `fail to create ${entity}`,
  failtoUpdate: `fail to update ${entity}`,
  failtoDelete: `fail to delete ${entity}`,
  createSuccessfully: `${entity} created successfully`,
  updateSuccessfully: `${entity} updated successfully`,
  deleteSuccessfully: `${entity} deleted successfully`,
  getsuccessfully: `${entity} retrieved successfully`,
  verified: `${entity} verified successfully`,
  notverified: `${entity} not verified`,
  invalidCreadintials: `invalid credentials`,
  loginSuccessfully: `login successfully`,
  notauthorized: `not authorized`,
  blocked: 'your account is blocked',
});

export const messages = {
  user: genrateMessage('user'),
  file: { required: 'file is required' },
  review: genrateMessage('review'),
  event: genrateMessage('event'),
  application: genrateMessage('application'),
  attendance: genrateMessage('attendance'),
  referral: genrateMessage('referral'),
  staff: genrateMessage('staff member'),
  paymentMethod: genrateMessage('payment method'),
};
