(function () {
  "use strict";

  var manifests = Object.freeze({
    "u25-no-injury": "./manifests/u25-no-injury.webmanifest",
    "partial-aerobic-preparation": "./manifests/partial-aerobic-preparation.webmanifest"
  });

  function courseIdFromLocation() {
    var params = new URLSearchParams(window.location.search);
    var queryId = String(params.get("course") || "").trim();
    if (queryId) return queryId;

    var match = String(window.location.hash || "").match(/^#course\/([^/?#]+)$/);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]).trim();
    } catch (_) {
      return "";
    }
  }

  var courseId = courseIdFromLocation();
  var href = manifests[courseId];
  if (!href) return;

  var link = document.createElement("link");
  link.rel = "manifest";
  link.href = href;
  document.head.appendChild(link);
})();
