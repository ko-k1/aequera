"use strict";
// Draws the fixture ad into the slot's iframe a moment after load, with a
// tracking pixel and script text an ad's description must leave out.
setTimeout(() => {
  const doc = document.getElementById("ad-frame").contentDocument;
  doc.open();
  doc.write(
    '<body style="margin:0">' +
      '<img src="adveil_ad.svg#pixel" width="1" height="1" alt="">' +
      "<script>var adConfig = 'not ad text';</" +
      "script>" +
      '<a href="https://example.org/click?id=7&adurl=https%3A%2F%2Fexample.net%2Fadvertiser%3Fref%3Dveil"><img src="adveil_ad.svg" width="300" height="250" alt="">Framed test ad</a>' +
      "</body>"
  );
  doc.close();
}, 300);
