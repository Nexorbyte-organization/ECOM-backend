import joi from 'joi';
import { eventActionRequestStatus, eventActionRequestType, eventCategories, genderPreference, eventStatus } from '../utils/constant/enums.js';

const categorySchema = joi.string().custom((value, helpers) => {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const compatible = normalized === 'sports_event' ? 'sport_event' : normalized;
    return Object.values(eventCategories).includes(compatible) ? value : helpers.error('any.invalid');
});

export class EventValidator {
    static create = joi.object({
        title: joi.string().min(3).max(100).required(),
        category: categorySchema.required(),
        eventDate: joi.date().required(),
        applicationDeadline: joi.date().less(joi.ref('eventDate')).required(),
        startTime: joi.string().required(),
        endTime: joi.string().required(),
        location: joi.string().required(),
        gatheringLocation: joi.string().allow('').optional(),
        photo: joi.alternatives().try(joi.string(), joi.object()).optional(),
        requiredCount: joi.number().integer().min(1).required(),
        specifyGenders: joi.boolean().default(false),
        malesCount: joi.number().integer().min(0).optional(),
        femalesCount: joi.number().integer().min(0).optional(),
        genderPreference: joi.string().valid(...Object.values(genderPreference)).default('any'),
        budget: joi.number().positive().required(),
        dressCode: joi.string().optional(),
        notes: joi.string().optional(),
        whatsappGroupLink: joi.string().uri().allow('').optional(),
    }).required();

    static updateStatus = joi.object({
        status: joi.string().valid(...Object.values(eventStatus)).required(),
    }).required();

    static update = joi.object({
        title: joi.string().min(3).max(100).optional(),
        category: categorySchema.optional(),
        eventDate: joi.date().optional(),
        applicationDeadline: joi.date().optional(),
        startTime: joi.string().optional(),
        endTime: joi.string().optional(),
        location: joi.string().optional(),
        gatheringLocation: joi.string().allow('').optional(),
        photo: joi.alternatives().try(joi.string(), joi.object()).allow(null).optional(),
        requiredCount: joi.number().integer().min(1).optional(),
        specifyGenders: joi.boolean().optional(),
        malesCount: joi.number().integer().min(0).allow(null).optional(),
        femalesCount: joi.number().integer().min(0).allow(null).optional(),
        genderPreference: joi.string().valid(...Object.values(genderPreference)).optional(),
        budget: joi.number().positive().optional(),
        dressCode: joi.string().allow('').optional(),
        notes: joi.string().allow('').optional(),
        whatsappGroupLink: joi.string().uri().allow('', null).optional(),
        status: joi.string().valid('cancelled').optional(),
    }).min(1).required();
}

export class ApplicationValidator {
    static apply = joi.object({
        eventId: joi.string().uuid().required(),
    }).required();

    static refer = joi.object({
        eventId: joi.string().uuid().required(),
        referredTalentId: joi.string().uuid().required(),
    }).required();

    static directBook = joi.object({
        eventId: joi.string().uuid().required(),
        talentId: joi.string().uuid().required(),
    }).required();

    static updateStatus = joi.object({
        status: joi.string().valid('accepted', 'rejected').required(),
    }).required();
}

export class AttendanceValidator {
    static mark = joi.object({
        talentId: joi.string().uuid().required(),
        status: joi.string().valid('present', 'absent', 'late').required(),
        checkInTime: joi.date().optional(),
    }).required();

    static checkIn = joi.object({
        token: joi.string().min(20).max(500).required(),
    }).required();
}

export class ReviewValidator {
    static create = joi.object({
        talentId: joi.string().uuid().optional(),
        reviewedUserId: joi.string().uuid().optional(),
        eventId: joi.string().uuid().optional(),
        reviewerId: joi.string().uuid().optional(),
        rating: joi.number().integer().min(1).max(5).required(),
        comment: joi.string().max(500).optional(),
    }).or('talentId', 'reviewedUserId').required();
}

export class StaffValidator {
    static invite = joi.object({
        fullName: joi.string().min(2).max(100).required(),
        email: joi.string().email().required(),
        password: joi.string().min(6).default('member123'),
        role: joi.string().valid(
            'organizer_member',
            'organizer_supervisor',
            'provider_member',
            'provider_supervisor'
        ).default('organizer_member'),
    }).required();

    static update = joi.object({
        fullName: joi.string().min(2).max(100).optional(),
        email: joi.string().email().optional(),
        password: joi.string().min(6).optional(),
        role: joi.string().valid(
            'organizer_member',
            'organizer_supervisor',
            'provider_member',
            'provider_supervisor'
        ).optional(),
    }).min(1).required();
}

export class SupervisorValidator {
    static assign = joi.object({
        supervisorUserId: joi.string().uuid().required(),
        add: joi.boolean().default(true),
    }).required();
}

export class PaymentMethodValidator {
    static add = joi.object({
        provider: joi.string().min(2).max(50).required(),
        numberOrDetail: joi.string().min(3).max(100).optional(),
        type: joi.string().valid('wallet', 'bank', 'cash').optional(),
        issuer: joi.string().max(50).optional(),
        accountHolderName: joi.string().min(2).max(100).optional(),
        bankCode: joi.string().max(30).optional(),
        mobileNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).optional(),
        iban: joi.string().min(8).max(50).optional(),
        accountNumber: joi.string().min(4).max(50).optional(),
    }).when(joi.object({ type: joi.valid('cash') }).unknown(), {
        then: joi.object(),
        otherwise: joi.object().or('numberOrDetail', 'mobileNumber', 'iban', 'accountNumber'),
    }).required();
}

export class EventActionRequestValidator {
    static create = joi.object({
        requestType: joi.string().valid(...Object.values(eventActionRequestType)).required(),
        reason: joi.string().max(1000).allow('').optional(),
    }).required();

    static resolve = joi.object({
        decision: joi.string().valid(eventActionRequestStatus.APPROVED, eventActionRequestStatus.REJECTED).required(),
    }).required();
}
