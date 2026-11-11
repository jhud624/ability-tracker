// Splits an activity's target facts into a short always-visible summary and
// collapsed "Coach notes" prose. Presentation only: nothing is dropped.
function activityCardText(activity) {
  const target = activity?.target || {};
  const duration = target.estimated_duration_minutes || target.duration_minutes;
  const summary = [
    target.distance_miles ? `${target.distance_miles} mi` : null,
    target.distance_km ? `${target.distance_km} km` : null,
    duration ? `About ${duration} min` : null
  ].filter(Boolean);
  const notes = [
    target.time_budget_minutes ? `${target.time_budget_minutes} min available` : null,
    target.intensity,
    target.notes || activity?.notes
  ].filter(Boolean);
  return { summary: summary.join(" · "), notes };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { activityCardText };
}
