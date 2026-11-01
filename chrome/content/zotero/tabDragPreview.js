'use strict';

/**
 * A temporary visual for one macOS tab drag, not another reader/editor window.
 *
 * Gecko's native drag service draws the canvas and moves it with the pointer,
 * including outside the application and between displays. We change that image
 * when the drag leaves/re-enters the source window. The real tab stays mounted
 * so its editor, pending writes and native drag-end target remain alive. Only
 * its tab-strip representation is hidden until cancellation or a committed move.
 * Nothing is uploaded, saved to disk, or copied into a second library item.
 *
 * Construction begins with an invisible native image, preserving normal
 * in-strip reordering. Capture the displayed document asynchronously, so a
 * drag never waits for another reader to initialize. A title card is available
 * immediately if the pointer leaves before the snapshot arrives.
 *
 * @param {Window} win - Owning chrome window (privileged Gecko APIs required)
 * @param {HTMLElement} tab - Stable source tab node, retained through dragend
 * @param {DataTransfer} transfer - The native dragstart's transferable object
 */
class TabDragPreview {
	constructor(win, tab, transfer) {
		this.win = win;
		this.tab = tab;
		this.transfer = transfer;
		this.active = true;
		this.outside = false;
		this.scale = win.devicePixelRatio;
		this.empty = this._canvas(1, 1);
		this.preview = this._canvas(420 * this.scale, 300 * this.scale);
		const dark = win.matchMedia('(prefers-color-scheme: dark)').matches;
		this.background = dark ? '#252525' : '#ffffff';
		this.foreground = dark ? '#f1f1f1' : '#202020';
		this._paintCard();
		transfer.setDragImage(this.empty, 0, 0);
		// Explicitly keep dragend targeted at the tab, even when its label was
		// grabbed and the tab's layout changes while outside the source window.
		transfer.addElement(tab);

		// dragleave identifies leaving the source document; source-side drag
		// events also update the image if Gecko supplies a point beyond its edge.
		// Listening on the document covers whitespace as well as the tab strip.
		this.listeners = {
			dragleave: event => this._leave(event),
			drag: () => this._track(),
			dragenter: () => this._enter(),
			dragover: () => this._enter()
		};
		for (const [type, listener] of Object.entries(this.listeners)) {
			win.document.addEventListener(type, listener, true);
		}
		this.onUnload = () => this.stop();
		win.addEventListener('unload', this.onUnload, { once: true });
		this.ready = this._capture();
	}

	/** Create a detached HTML canvas; Gecko accepts it without adding visible DOM. */
	_canvas(width, height) {
		const canvas = this.win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}

	/** Paint a compact window outline and readable, clipped tab title. */
	_paintCard() {
		const ctx = this.preview.getContext('2d');
		ctx.save();
		ctx.scale(this.scale, this.scale);
		ctx.fillStyle = this.background;
		ctx.beginPath();
		ctx.roundRect(0, 0, 420, 300, 9);
		ctx.fill();
		ctx.strokeStyle = '#888888';
		ctx.stroke();
		ctx.fillStyle = this.foreground;
		ctx.font = '13px system-ui';
		ctx.beginPath();
		ctx.rect(16, 0, 388, 34);
		ctx.clip();
		ctx.fillText(this.tab.querySelector('.tab-name')?.textContent || '', 16, 23);
		ctx.restore();
	}

	/**
	 * Snapshot only this tab's displayed content (PDF/EPUB/note), never unrelated
	 * windows. drawSnapshot includes the reader's nested frames. Scale the bitmap
	 * into the card without distorting it. Dispose GPU resources even if the drag
	 * ended while capture was pending; a late result must not revive the preview.
	 */
	async _capture() {
		let bitmap;
		try {
			const content = this.win.document.getElementById(this.tab.dataset.id);
			const rect = content?.getBoundingClientRect();
			if (!rect?.width || !rect.height) return;
			bitmap = await this.win.browsingContext.currentWindowGlobal.drawSnapshot(
				rect, this.preview.width / rect.width, this.background);
			if (!this.active) return;
			const ctx = this.preview.getContext('2d');
			const ratio = Math.min((this.preview.width - 4) / bitmap.width,
				(this.preview.height - 36 * this.scale) / bitmap.height);
			ctx.drawImage(bitmap, (this.preview.width - bitmap.width * ratio) / 2,
				35 * this.scale, bitmap.width * ratio, bitmap.height * ratio);
			this.preview.dataset.snapshotReady = 'true';
			if (this.outside) this._updateImage(this.preview);
		}
		catch (error) {
			// A closing/unloaded document can fail to snapshot. The title card is
			// still a valid drag image; this optional visual must not block a move.
			if (this.active) this.win.Zotero.debug(`Tab drag snapshot unavailable: ${error}`, 2);
		}
		finally {
			bitmap?.close();
		}
	}

	/**
	 * Ignore internal descendant transitions and unusable Gecko (0,0) events.
	 * A tiny edge tolerance handles the final dragleave being reported directly
	 * on the border, before the next source-side drag event is dispatched.
	 */
	_leave(event) {
		if (event.relatedTarget || !this._hasPoint(event)) return;
		const { screenX: x, screenY: y } = event;
		const w = this.win;
		if (x <= w.screenX + 2 || x >= w.screenX + w.outerWidth - 2
			|| y <= w.screenY + 2 || y >= w.screenY + w.outerHeight - 2) this._show(true);
	}

	/** Gecko sometimes sends (0,0) for drag events; that is not a cursor location. */
	_hasPoint(event) {
		return Number.isFinite(event.screenX) && Number.isFinite(event.screenY)
			&& (event.screenX !== 0 || event.screenY !== 0);
	}

	/**
	 * Track source drags without depending on macOS's often-empty mouse position.
	 * Gecko sends a source `drag` before the target's `dragover`. Give that target
	 * dispatch time to arrive: if it reaches this document, _enter cancels the
	 * pending preview. Otherwise the drag has left our surface. Do not restart
	 * the timer on each source event, or continuous movement would starve it.
	 * This also handles leaving directly onto the desktop without a dragleave.
	 */
	_track() {
		if (!this.active || this.departureTimer) return;
		this.departureTimer = this.win.setTimeout(() => {
			this.departureTimer = null;
			this._show(true);
		}, 32);
	}

	/** A source-document target event means the tab is back over our own surface. */
	_enter() {
		this.win.clearTimeout(this.departureTimer);
		this.departureTimer = null;
		this._show(false);
	}

	/**
	 * Change the OS-owned drag image. Keep this operation separate from layout:
	 * if the native service rejects it, leave the source visible and usable.
	 */
	_updateImage(canvas) {
		this.transfer.updateDragImage(canvas, 20 * this.scale, 16 * this.scale);
	}

	/** Hide/collapse the tab only after its replacement drag image was accepted. */
	_show(outside) {
		if (!this.active || this.outside === outside) return;
		try {
			this._updateImage(outside ? this.preview : this.empty);
			this.outside = outside;
			this.tab.toggleAttribute('data-drag-preview', outside);
		}
		catch (error) {
			this.win.Zotero.debug(`Tab drag image unavailable: ${error}`, 2);
			this.restore();
		}
	}

	/** Restore the original tab on re-entry, cancellation or a failed handoff. */
	restore() {
		this.tab.removeAttribute('data-drag-preview');
		this.outside = false;
	}

	/**
	 * Release listeners on every exit path, including window shutdown. On a real
	 * outside drop the caller temporarily retains the hidden state while opening
	 * the destination, avoiding a visible source-tab flash before it is removed.
	 */
	stop({ restore = true } = {}) {
		this.active = false;
		this.win.clearTimeout(this.departureTimer);
		this.departureTimer = null;
		for (const [type, listener] of Object.entries(this.listeners)) {
			this.win.document.removeEventListener(type, listener, true);
		}
		this.win.removeEventListener('unload', this.onUnload);
		if (restore) this.restore();
	}
}

module.exports = TabDragPreview;
