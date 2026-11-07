'use strict';

/**
 * Follow the main-window tab tear-off boundary: an unaccepted, deliberate drop
 * outside the source tab bar (including its small lower margin) opens a window.
 * The caller supplies the bar's bottom in screen coordinates and its height.
 * Library tabs and all platforms use the same rule; cancellation never moves a tab.
 */
function shouldDetachTab(drag, source) {
	if (!drag.tabID || drag.userCancelled || drag.dropEffect !== 'none') return false;
	if (![drag.screenX,
		drag.screenY,
		source.screenX,
		source.screenY,
		source.outerWidth,
		source.tabBarBottom,
		source.tabBarHeight].every(Number.isFinite)
		|| source.outerWidth <= 0 || source.tabBarHeight <= 0) return false;
	return !(drag.screenX > source.screenX
		&& drag.screenX < source.screenX + source.outerWidth
		&& drag.screenY > source.screenY
		&& drag.screenY < source.tabBarBottom + source.tabBarHeight * 1.5);
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
