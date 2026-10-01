import { Op } from 'sequelize';

const SORTABLE_FIELD = /^-?[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Ordering by a secret leaks information about it, even without returning the value.
const UNSORTABLE_FIELDS = new Set([
  'password',
  'otp',
  'otpExpiry',
  'otpAttempts',
  'lastOtpRequest',
  'otpVerified',
  'refreshTokenHash',
  'refreshTokenExpiresAt',
  'paymentMethods',
  'email',
  'mobileNumber',
  'whatsappNumber',
]);

export class ApiFeature {
  constructor(queryData) {
    this.queryData = queryData;
    this.queryOptions = {
      where: {},
      order: [],
      attributes: undefined,
      limit: undefined,
      offset: undefined,
    };
  }

  pagination() {
    let { page, size } = this.queryData;
    const { limit } = this.queryData;
    page = parseInt(page) || 1;
    size = parseInt(size ?? limit) || 10;
    if (page <= 0) page = 1;
    if (size <= 0) size = 10;
    if (size > 100) size = 100;
    this.queryOptions.limit = size;
    this.queryOptions.offset = (page - 1) * size;
    return this;
  }

  sort() {
    if (this.queryData.sort) {
      const sortFields = String(this.queryData.sort)
        .split(',')
        .map((field) => field.trim())
        .filter(
          (field) => SORTABLE_FIELD.test(field) && !UNSORTABLE_FIELDS.has(field.replace(/^-/, '')),
        )
        .map((field) => (field.startsWith('-') ? [field.substring(1), 'DESC'] : [field, 'ASC']));
      this.queryOptions.order = sortFields;
    }
    return this;
  }

  select() {
    if (this.queryData.select) {
      this.queryOptions.attributes = this.queryData.select.split(',');
    }
    return this;
  }

  filter() {
    const queryObj = { ...this.queryData };
    const excludedFields = ['page', 'sort', 'select', 'size', 'limit'];
    excludedFields.forEach((field) => delete queryObj[field]);

    const sequelizeWhere = {};
    const operatorMap = {
      gt: Op.gt,
      gte: Op.gte,
      lt: Op.lt,
      lte: Op.lte,
      in: Op.in,
    };

    for (const [key, value] of Object.entries(queryObj)) {
      if (typeof value === 'object' && value !== null) {
        const conditions = {};
        for (const [op, val] of Object.entries(value)) {
          if (operatorMap[op]) {
            conditions[operatorMap[op]] = val;
          }
        }
        sequelizeWhere[key] = conditions;
      } else {
        sequelizeWhere[key] = value;
      }
    }

    this.queryOptions.where = { ...this.queryOptions.where, ...sequelizeWhere };
    return this;
  }

  build() {
    return this.queryOptions;
  }

  // Static helper – replaces old pagination.js
  static paginateResponse(data, page, limit, total) {
    const parsedPage = parseInt(page);
    const parsedLimit = parseInt(limit);
    const parsedTotal = parseInt(total);
    const totalPages = Math.ceil(parsedTotal / parsedLimit);
    return {
      data,
      total: parsedTotal,
      page: parsedPage,
      limit: parsedLimit,
      totalPages,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: parsedTotal,
        totalPages,
      },
    };
  }
}
