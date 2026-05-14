(function () {
  const section = document.querySelector(".testimonials");
  const grid = section?.querySelector(".card-grid");

  if (!section || !grid) return;

  const API_URL = "/api/google-reviews?minRating=4&limit=3";

  function escapeHtml(input) {
    const div = document.createElement("div");
    div.textContent = String(input ?? "");
    return div.innerHTML;
  }

  function stars(rating) {
    const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return "★★★★★".slice(0, value) + "☆☆☆☆☆".slice(0, 5 - value);
  }

  function renderReview(review) {
    const author = escapeHtml(review.authorName || "Guest");
    const text = escapeHtml(review.text || "");
    const rating = Number(review.rating) || 0;

    return `
      <article class="review-card">
        <div class="stars" aria-label="${rating} out of 5 stars">${stars(rating)}</div>
        <p>“${text}”</p>
        <span class="reviewer">- ${author}</span>
      </article>
    `;
  }

  async function load() {
    try {
      const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) return;

      const data = await res.json();
      const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
      if (!reviews.length) return;

      grid.innerHTML = reviews.map(renderReview).join("");
    } catch {
      // Keep the static fallback testimonials.
    }
  }

  load();

  // Fetch and display Google Photos
  async function loadGooglePhotos() {
    const photoContainer = document.getElementById("google-photos-grid");
    if (!photoContainer) return;

    try {
      const res = await fetch(API_URL);
      const data = await res.json();
      
      if (data.photos && data.photos.length > 0) {
        photoContainer.innerHTML = data.photos.map(photoRef => `
          <img src="/.netlify/functions/google-photo?ref=${photoRef}&maxwidth=600" alt="Restaurant photo from Google" class="google-gallery-image" />
        `).join("");
      }
    } catch (error) {
      console.error("Failed to load Google photos:", error);
    }
  }

  loadGooglePhotos();
})();
