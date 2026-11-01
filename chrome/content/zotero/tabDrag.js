'use strict';

/**
 * Decide whether a completed drag means "open this tab in its own window".
 *
 * This module deliberately has no DOM or operating-system dependencies, so the
 * boundary rules can be tested without opening a window. The caller supplies
 * Gecko's drag-end values and the source window's outer bounds in CSS pixels.
 * `none` means no drop target accepted the drag; it does NOT prove that the user
 * released it deliberately, which is why mozUserCancelled is checked separately.
 * A small margin prevents a shaky tab reorder near the window border from
 * creating a window. Drops anywhere inside the window remain ordinary drags.
 *
 * @param {Object} drag - Platform, locally tracked tab ID, coordinates and outcome
 * @param {Object} source - screenX, screenY, outerWidth and outerHeight
 * @returns {Boolean} True only for a deliberate outside-window macOS drop
 */
function shouldDetachTab(drag, source) {
	if (!drag.isMac || !drag.tabID || drag.tabID === 'zotero-pane'
		|| drag.userCancelled || drag.dropEffect !== 'none') return false;
	if (![drag.screenX, drag.screenY, source.screenX, source.screenY, source.outerWidth, source.outerHeight].every(Number.isFinite)
		|| source.outerWidth <= 0 || source.outerHeight <= 0) return false;
	const margin = 8;
	return drag.screenX < source.screenX - margin
		|| drag.screenX > source.screenX + source.outerWidth + margin
		|| drag.screenY < source.screenY - margin
		|| drag.screenY > source.screenY + source.outerHeight + margin;
}

/**
 * Place a window near the drop while keeping it within the destination display's
 * usable area (excluding the macOS menu bar and Dock). All arguments and results
 * use desktop pixels, not physical Retina pixels. Negative monitor origins are
 * retained. Resizing oversized windows before moving avoids off-screen controls.
 *
 * @param {{x: Number, y: Number}} point - Drop point in desktop coordinates
 * @param {{width: Number, height: Number}} size - Preferred outer window size
 * @param {{left: Number, top: Number, width: Number, height: Number}} screen
 * @returns {{left: Number, top: Number, width: Number, height: Number}}
 */
function detachedWindowBounds(point, size, screen) {
	const width = Math.min(size.width, screen.width);
	const height = Math.min(size.height, screen.height);
	return {
		left: Math.round(Math.max(screen.left, Math.min(point.x - 40, screen.left + screen.width - width))),
		top: Math.round(Math.max(screen.top, Math.min(point.y - 20, screen.top + screen.height - height))),
		width: Math.round(width),
		height: Math.round(height)
	};
}

/**
 * Bound an asynchronous handoff stage without relying on old Bluebird APIs.
 * Timers are cleared on success AND rejection. The operation itself is not
 * cancelled; callers must clean up a window that arrives after the timeout.
 *
 * @param {Promise} operation - Editor opening, initialization or persistence
 * @param {Number} milliseconds - Maximum wait for this stage
 * @returns {Promise} The operation's value, or its original error/timeout
 */
async function withTimeout(operation, milliseconds) {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out preparing the detached window')), milliseconds);
			})
		]);
	}
	finally {
		clearTimeout(timer);
	}
}

module.exports = { shouldDetachTab, detachedWindowBounds, withTimeout };
