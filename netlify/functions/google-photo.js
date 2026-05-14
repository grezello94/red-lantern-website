const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

exports.handler = async (event) => {
  try {
    const photoReference = event.queryStringParameters?.ref;
    const maxWidth = event.queryStringParameters?.maxwidth || 800; // Adjust max width as needed

    if (!photoReference || !GOOGLE_PLACES_API_KEY) {
      return { statusCode: 400, body: 'Missing photo reference or API key' };
    }

    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${photoReference}&key=${GOOGLE_PLACES_API_KEY}`;

    // Google Places Photo API returns a 302 redirect to the actual image URL.
    // We use fetch with redirect: 'manual' to capture that location and safely forward the user to it.
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');

    if (location) {
      return {
        statusCode: 302,
        headers: {
          Location: location,
          'Cache-Control': 'public, max-age=86400' // Cache the image redirect in the browser for 24 hours
        }
      };
    }

    return { statusCode: 404, body: 'Photo not found' };
  } catch (err) {
    return { statusCode: 500, body: 'Server Error' };
  }
};