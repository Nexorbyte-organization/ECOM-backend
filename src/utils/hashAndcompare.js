import bcrypt from 'bcryptjs';

export class HashService {
  static hashPassword({ password = '', saltRound = 8 }) {
    return bcrypt.hashSync(password, saltRound);
  }

  static comparePassword({ password = '', hashPassword = '' }) {
    return bcrypt.compareSync(password, hashPassword);
  }
}
