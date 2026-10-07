import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlTemplateService } from '../src/utils/htmlTemplate.js';

process.env.FRONTEND_URL = 'https://app.example.test/, http://localhost:3001';

test('notification email uses the branded layout with a button to the in-app link', () => {
    const html = HtmlTemplateService.notification({
        title: 'Assigned to an event map location',
        message: 'You have been assigned to “gate 4” on the map for “Villa Party”.',
        type: 'info',
        link: '/talent/events/43575802-c57f-451a-b3ed-086b55f90d4c/map',
    });
    assert.match(html, /People make the moment/);
    assert.match(html, />Update</);
    assert.match(html, /<h1[^>]*>Assigned to an event map location<\/h1>/);
    assert.match(html, /href="https:\/\/app\.example\.test\/talent\/events\/43575802-c57f-451a-b3ed-086b55f90d4c\/map"/);
    assert.match(html, />View your location</);
});

test('notification email escapes user-supplied content', () => {
    const html = HtmlTemplateService.notification({
        title: 'New event application',
        message: '<script>alert(1)</script> applied to “A & B”.',
        type: 'success',
        link: '/provider/events/1',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; applied to “A &amp; B”\./);
    assert.match(html, />Good news</);
    assert.match(html, />View event</);
});

test('notification email only links inside the app', () => {
    for (const link of [null, 'https://evil.example/phish', '//evil.example/phish']) {
        const html = HtmlTemplateService.notification({ title: 'Event request approved', message: 'Done.', type: 'danger', link });
        assert.match(html, /href="https:\/\/app\.example\.test"/);
        assert.match(html, />Open OO-Ushers</);
        assert.doesNotMatch(html, /evil\.example/);
    }
});

test('notification plain-text alternative includes the link', () => {
    assert.equal(
        HtmlTemplateService.notificationText({ message: 'Event cancelled.', link: '/talent/events' }),
        'Event cancelled.\n\nhttps://app.example.test/talent/events',
    );
});
