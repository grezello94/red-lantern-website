const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACE_ID = process.env.GOOGLE_PLACE_ID;
const GOOGLE_PLACE_QUERY = process.env.GOOGLE_PLACE_QUERY;
const GOOGLE_LOCATION_BIAS = process.env.GOOGLE_LOCATION_BIAS;

let cachedResolvedPlaceId = null;

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed)) return Math.max(min, Math.min(max, parsed));
  return fallback;
}

async function resolvePlaceId() {
  if (GOOGLE_PLACE_ID) return GOOGLE_PLACE_ID;
  if (cachedResolvedPlaceId) return cachedResolvedPlaceId;
  if (!GOOGLE_PLACE_QUERY) return null;

  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
  );
  url.searchParams.set("input", GOOGLE_PLACE_QUERY);
  url.searchParams.set("inputtype", "textquery");
  url.searchParams.set("fields", "place_id");
  if (GOOGLE_LOCATION_BIAS) {
    // Example: "15.2687923,73.9287667" -> "point:15.2687923,73.9287667"
    url.searchParams.set("locationbias", `point:${GOOGLE_LOCATION_BIAS}`);
  }
  url.searchParams.set("key", GOOGLE_PLACES_API_KEY);

  const response = await fetch(url.toString());
  const payload = await response.json();

  if (!response.ok || payload?.status !== "OK") {
    throw new Error(
      payload?.error_message || payload?.status || "FindPlaceFromText failed",
    );
  }

  const candidate = Array.isArray(payload?.candidates)
    ? payload.candidates[0]
    : null;
  const placeId = candidate?.place_id || null;
  cachedResolvedPlaceId = placeId;
  return placeId;
}

exports.handler = async (event) => {
  try {
    if (!GOOGLE_PLACES_API_KEY || (!GOOGLE_PLACE_ID && !GOOGLE_PLACE_QUERY)) {
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error:
            "Missing GOOGLE_PLACES_API_KEY and/or GOOGLE_PLACE_ID (or GOOGLE_PLACE_QUERY) env vars on the server.",
        }),
      };
    }

    const placeId = await resolvePlaceId();
    if (!placeId) {
      return {
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error:
            "Could not resolve a Place ID. Set GOOGLE_PLACE_ID directly, or set GOOGLE_PLACE_QUERY (optionally GOOGLE_LOCATION_BIAS).",
        }),
      };
    }

    const minRating = clampInt(event.queryStringParameters?.minRating, 1, 5, 4);
    const limit = clampInt(event.queryStringParameters?.limit, 1, 10, 3);

    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("fields", "reviews");
    url.searchParams.set("reviews_sort", "newest");
    url.searchParams.set("key", GOOGLE_PLACES_API_KEY);

    const response = await fetch(url.toString());
    const payload = await response.json();

    if (!response.ok || payload?.status !== "OK") {
      return {
        statusCode: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: "Google Places API error",
          details: payload?.error_message || payload?.status || "Unknown",
        }),
      };
    }

    const rawReviews = payload?.result?.reviews;
    const reviewsArray = Array.isArray(rawReviews) ? rawReviews : [];

    const reviews = reviewsArray
      .filter((r) => {
        const rating = Number(r?.rating) || 0;
        const text = String(r?.text || "").trim();
        return rating >= minRating && text.length > 0;
      })
      .sort((a, b) => {
        const ratingDiff = (Number(b?.rating) || 0) - (Number(a?.rating) || 0);
        if (ratingDiff !== 0) return ratingDiff;
        return (Number(b?.time) || 0) - (Number(a?.time) || 0);
      })
      .slice(0, limit)
      .map((r) => ({
        rating: Number(r?.rating) || 0,
        text: r?.text || "",
        authorName: r?.author_name || "",
        time: Number(r?.time) || 0,
      }));

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
      },
      body: JSON.stringify({
        source: "google-places",
        placeId,
        minRating,
        reviews,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "Unexpected server error",
        details: String(err?.message || err),
      }),
    };
  }
};
