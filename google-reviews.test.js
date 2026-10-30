/** @jest-environment node */
'use strict';

const fs = require('fs');

const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
const descriptionHelpers = serverSource.slice(
  serverSource.indexOf('function stripHtml('),
  serverSource.indexOf('function trimDescription(')
);
const googleReviewHelpers = serverSource.slice(
  serverSource.indexOf('function googleBusinessConfig('),
  serverSource.indexOf('function normalizeBlogs(')
);

function loadImporter(extraEnv = {}, pages = []) {
  const env = {
    GOOGLE_BUSINESS_ACCOUNT_ID: 'accounts/test-account',
    GOOGLE_BUSINESS_LOCATION_ID: 'locations/test-location',
    GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'test-client',
    GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: 'test-secret',
    GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: 'test-refresh-token',
    ...extraEnv,
  };
  let pageIndex = 0;
  const fetcher = jest.fn(async (input) => {
    if (String(input) === 'https://oauth2.googleapis.com/token')
      return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    if (pageIndex >= pages.length) throw new Error('Unexpected extra Google review page request.');
    const page = pages[pageIndex++];
    return {
      ok: !page.error,
      status: page.error ? 503 : 200,
      json: async () => page,
    };
  });
  const importer = new Function(
    'process',
    'fetch',
    'URL',
    'URLSearchParams',
    `${descriptionHelpers}\n${googleReviewHelpers}\nreturn {
      googleBusinessConfig, fetchFiveStarGoogleReviews, mergeReviews, normalizeGoogleReview
    };`
  )({ env }, fetcher, URL, URLSearchParams);
  return { ...importer, fetcher };
}

function reviews(start, count) {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return {
      name: `accounts/test-account/locations/test-location/reviews/review-${id}`,
      reviewId: `review-${id}`,
      reviewer: { displayName: `Guest ${id}` },
      starRating: 'FIVE',
      comment: `Excellent dinner and friendly service, visit ${id}.`,
      createTime: '2026-10-01T12:00:00Z',
      updateTime: '2026-10-02T12:00:00Z',
    };
  });
}

function pageRequests(fetcher) {
  return fetcher.mock.calls.filter(([input]) => String(input).includes('/reviews'));
}

describe('Google Business review import', () => {
  test('imports all by default and accepts an explicit limit without the former 100-review cap', () => {
    for (const value of [undefined, '', '0', 'all', '-1', 'invalid', 'Infinity', 'NaN']) {
      const { googleBusinessConfig } = loadImporter({ GOOGLE_REVIEWS_SYNC_LIMIT: value });
      expect(googleBusinessConfig().syncLimit).toBe(0);
    }
    for (const value of ['1', '120', '250']) {
      const { googleBusinessConfig } = loadImporter({ GOOGLE_REVIEWS_SYNC_LIMIT: value });
      expect(googleBusinessConfig().syncLimit).toBe(Number(value));
    }
  });

  test('imports more than 100 written five-star reviews and follows pages with no eligible reviews', async () => {
    const { fetchFiveStarGoogleReviews, fetcher } = loadImporter({}, [
      { reviews: reviews(1, 50), nextPageToken: 'page-two' },
      {
        reviews: [
          { ...reviews(1000, 1)[0], starRating: 'FOUR' },
          { ...reviews(1001, 1)[0], comment: '' },
          { ...reviews(1002, 1)[0], comment: '<p>&nbsp;</p>' },
        ],
        nextPageToken: 'page-three',
      },
      { reviews: reviews(51, 50), nextPageToken: 'page-four' },
      { reviews: reviews(101, 27) },
    ]);

    const imported = await fetchFiveStarGoogleReviews();

    expect(imported).toHaveLength(127);
    expect(imported[0]).toMatchObject({
      name: 'Guest 1',
      stars: '★★★★★',
      googleReviewId: 'review-1',
      googleCreateTime: '2026-10-01T12:00:00Z',
      googleUpdateTime: '2026-10-02T12:00:00Z',
    });
    expect(imported[126].name).toBe('Guest 127');
    const requests = pageRequests(fetcher);
    expect(requests).toHaveLength(4);
    expect(requests.map(([url]) => url.searchParams.get('pageToken'))).toEqual([
      null, 'page-two', 'page-three', 'page-four',
    ]);
    for (const [url, options] of requests) {
      expect(url.pathname).toBe('/v4/accounts/test-account/locations/test-location/reviews');
      expect(url.searchParams.get('pageSize')).toBe('50');
      expect(options.headers.Authorization).toBe('Bearer test-access-token');
    }
  });

  test('honors an optional 120-review limit across pages without requesting the next page', async () => {
    const { fetchFiveStarGoogleReviews, fetcher } = loadImporter(
      { GOOGLE_REVIEWS_SYNC_LIMIT: '120' },
      [
        { reviews: reviews(1, 50), nextPageToken: 'page-two' },
        { reviews: reviews(51, 50), nextPageToken: 'page-three' },
        { reviews: reviews(101, 50), nextPageToken: 'page-four' },
      ]
    );

    const imported = await fetchFiveStarGoogleReviews();

    expect(imported).toHaveLength(120);
    expect(imported[119].googleReviewId).toBe('review-120');
    expect(pageRequests(fetcher)).toHaveLength(3);
  });

  test('rejects a repeated page token instead of looping or returning a partial import', async () => {
    const { fetchFiveStarGoogleReviews, fetcher } = loadImporter({}, [
      { reviews: reviews(1, 1), nextPageToken: 'repeated-page' },
      { reviews: reviews(2, 1), nextPageToken: 'repeated-page' },
    ]);

    await expect(fetchFiveStarGoogleReviews()).rejects.toThrow(/paginat|page.*token|repeat/i);
    expect(pageRequests(fetcher)).toHaveLength(2);
  });

  test('rejects a later page failure instead of reporting the earlier reviews as a complete import', async () => {
    const { fetchFiveStarGoogleReviews, fetcher } = loadImporter({}, [
      { reviews: reviews(1, 50), nextPageToken: 'failed-page' },
      { error: { message: 'Google review service temporarily unavailable.' } },
    ]);

    await expect(fetchFiveStarGoogleReviews()).rejects.toThrow(
      'Google review service temporarily unavailable.'
    );
    expect(pageRequests(fetcher)).toHaveLength(2);
  });

  test('repeated imports retain manual reviews, update existing Google reviews, and avoid duplicates', () => {
    const { mergeReviews, normalizeGoogleReview } = loadImporter();
    const googleReview = normalizeGoogleReview(reviews(1, 1)[0]);
    const manualReview = { name: 'Local guest', stars: '★★★★★', text: 'Lovely food and service.' };
    const initial = mergeReviews([manualReview], [googleReview]);
    const updatedReview = { ...googleReview, text: 'An updated Google review of our visit.' };

    const updated = mergeReviews(initial, [updatedReview]);
    const repeated = mergeReviews(updated, [updatedReview]);

    expect(repeated).toHaveLength(2);
    expect(repeated).toEqual(updated);
    expect(repeated.find((review) => review.googleReviewId === 'review-1').text).toBe(
      'An updated Google review of our visit.'
    );
    expect(repeated).toContainEqual(manualReview);
    expect(initial[0].text).toBe(googleReview.text);
  });
});
