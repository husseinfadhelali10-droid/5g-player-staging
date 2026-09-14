(function () {
  "use strict";

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
  if (!/^[a-z0-9-]{3,40}$/i.test(courseId)) return;

  var link = document.createElement("link");
  link.rel = "manifest";
  link.href = "./manifests/" + encodeURIComponent(courseId) + ".webmanifest";
  document.head.appendChild(link);
})();
