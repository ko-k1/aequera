/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// An ad server that does not answer: no response for 30 seconds (Ad Veil's
// veil mode cancels it after 10), then an empty script, so the server ends
// the request itself if nothing does.
var timer = null;

function handleRequest(request, response) {
  response.processAsync();
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    () => {
      try {
        response.setHeader("Content-Type", "text/javascript", false);
        response.write("");
        response.finish();
      } catch {
        // The client went away first.
      }
    },
    30000,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
}
