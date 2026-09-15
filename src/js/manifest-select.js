(function () {
  "use strict";

  var storageManifestBase =
    "https://fukltjkgeagppfqjlali.supabase.co/storage/v1/object/public/course-content/manifests/";
  var publicId = String(new URLSearchParams(window.location.search).get("course") || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) return;

  var link = document.createElement("link");
  link.rel = "manifest";
  link.crossOrigin = "anonymous";
  link.href = storageManifestBase + encodeURIComponent(publicId) + ".webmanifest";
  document.head.appendChild(link);
})();
