import { Op } from 'sequelize';
import { Application, Attendance, Event, Review, User } from '../../db/index.js';

// FR-VER-01: an usher is verified automatically after enough good events and a high rating. The
// events must come from several organizations so one organization cannot create a badge for a
// friend with staged events.
export const AUTO_VERIFY_MIN_EVENTS = 10;
export const AUTO_VERIFY_MIN_RATING = 4.0;
export const AUTO_VERIFY_MIN_ORGANIZATIONS = 3;
// Each organization's first reviews of an usher count fully; later ones from the same
// organization count less, so a single organization cannot inflate a rating.
export const FULL_WEIGHT_REVIEWS_PER_ORGANIZATION = 2;
export const REPEAT_REVIEW_WEIGHT = 0.25;

// Weighted average of reviews in the order they were written.
export const weightedRating = (reviews) => {
    const seen = new Map();
    let total = 0;
    let weights = 0;
    [...reviews]
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .forEach((review) => {
            const count = (seen.get(review.reviewerId) || 0) + 1;
            seen.set(review.reviewerId, count);
            const weight = count <= FULL_WEIGHT_REVIEWS_PER_ORGANIZATION ? 1 : REPEAT_REVIEW_WEIGHT;
            total += review.rating * weight;
            weights += weight;
        });
    return weights ? Math.round((total / weights) * 10) / 10 : 0;
};

export const qualifiesForVerification = ({ attendedEvents, rating, organizations }) => (
    attendedEvents >= AUTO_VERIFY_MIN_EVENTS
    && rating >= AUTO_VERIFY_MIN_RATING
    && organizations >= AUTO_VERIFY_MIN_ORGANIZATIONS
);

export async function refreshTalentRating(talentId) {
    const talent = await User.findByPk(talentId);
    if (!talent) return null;
    const reviews = await Review.findAll({
        where: { reviewedUserId: talentId },
        attributes: ['reviewerId', 'rating', 'createdAt'],
    });
    talent.rate = weightedRating(reviews);
    talent.totalRatings = reviews.length;
    await talent.save();
    return talent;
}

export async function checkAndAutoVerify(userId) {
    const user = await User.findByPk(userId);
    if (!user || user.role !== 'usher') return;

    const acceptedApps = await Application.findAll({ where: { talentId: userId, status: 'accepted' }, attributes: ['eventId'] });
    const eventIds = acceptedApps.map((application) => application.eventId);
    const records = eventIds.length
        ? await Attendance.findAll({ where: { talentId: userId, eventId: { [Op.in]: eventIds } }, attributes: ['eventId', 'status'] })
        : [];
    const attended = records.filter((record) => ['present', 'late'].includes(record.status));
    const organizations = attended.length
        ? new Set((await Event.findAll({
            where: { id: { [Op.in]: attended.map((record) => record.eventId) } },
            attributes: ['organizerId'],
            paranoid: false,
        })).map((event) => event.organizerId)).size
        : 0;

    user.completedEventsCount = attended.length;
    user.reliabilityScore = records.length > 0 ? Math.round((attended.length / records.length) * 100) : 100;
    if (qualifiesForVerification({ attendedEvents: attended.length, rating: user.rate || 0, organizations })) {
        user.isVerified = true;
    }
    await user.save();
}
