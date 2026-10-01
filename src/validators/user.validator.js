import joi from "joi";
import { roles } from "../utils/constant/enums.js";
import { generalFields } from "../middlewares/validation.js";

export class UserValidator {
    static signup = joi.object({
        fullName: joi.string().min(3).max(50).optional(),
        userName: joi.string().min(3).max(30).optional(),
        email: generalFields.email.required(),
        password: generalFields.password,
        mobileNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).optional(),
        city: joi.string().optional(),
        experience: joi.number().integer().min(0).optional(),
        role: joi.string().valid('usher', 'organizer', 'talent', 'provider').required(),
        languages: joi.array().items(joi.string().min(2).max(50)).optional(),
        eventCategories: joi.array().items(joi.string().min(2).max(50)).optional(),
    }).required();

    static login = joi.object({
        email: generalFields.email.required(),
        password: generalFields.password
    }).required();

    static forgetPassword = joi.object({
        email: generalFields.email.required()
    }).required();

    static verifyOtp = joi.object({
        email: generalFields.email.required(),
        otp: joi.string().length(6).required()
    }).required();

    static resetPassword = joi.object({
        resetToken: joi.string().min(20).required(),
        newPassword: generalFields.password
    }).required();
}

export class AdminUserValidator {
    static invite = joi.object({
        fullName: joi.string().min(2).max(100).optional(),
        companyName: joi.string().min(2).max(100).optional(),
        email: generalFields.email.required(),
        password: joi.string().min(6).optional(),
        role: joi.string().valid(
            ...Object.values(roles),
            'talent',
            'provider',
            'provider_member',
            'provider_supervisor'
        ).required(),
        city: joi.string().allow('').optional(),
        mobileNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).optional(),
        providerOwnerId: joi.string().uuid().optional(),
        providerProfileId: joi.string().uuid().optional(),
    }).required();
}

export class UsherProfileValidator {
    static update = joi.object({
        fullName: joi.string().min(2).max(100).optional(),
        city: joi.string().max(100).optional(),
        experience: joi.number().integer().min(0).max(80).optional(),
        experienceYears: joi.number().integer().min(0).max(80).optional(),
        languages: joi.array().items(joi.string().min(2).max(50)).optional(),
        eventCategories: joi.array().items(joi.string().min(2).max(50)).optional(),
        categories: joi.array().items(joi.string().min(2).max(50)).optional(),
        workCities: joi.array().items(joi.string().min(1).max(100)).optional(),
        education: joi.string().allow('').optional(),
        refusedCategories: joi.array().items(joi.string().min(2).max(50)).optional(),
        availabilityDates: joi.array().items(joi.string().max(30)).optional(),
        mobileNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).allow('').optional(),
        phoneNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).allow('').optional(),
        whatsappNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).allow('').optional(),
        whatsappConsentGiven: joi.boolean().optional(),
        portfolio: joi.array().items(joi.any()).optional(),
        portfolioImages: joi.array().items(joi.any()).optional(),
    }).min(1).required();
}

export class OrganizerProfileValidator {
    static update = joi.object({
        fullName: joi.string().min(2).max(100).optional(),
        companyName: joi.string().min(2).max(100).optional(),
        description: joi.string().max(3000).allow('').optional(),
        city: joi.string().max(150).allow('').optional(),
        location: joi.string().max(150).allow('').optional(),
        mobileNumber: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).allow('').optional(),
        phone: joi.string().pattern(/^\+?[0-9][0-9\s-]{8,18}$/).allow('').optional(),
        website: joi.string().uri().allow('').optional(),
        autoAcceptHighRatedTalents: joi.boolean().optional(),
    }).min(1).required();
}
