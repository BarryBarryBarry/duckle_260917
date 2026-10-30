// Where the guided tour's card sits. Kept apart from GuidedTour so the arithmetic can be
// run by check-logic without a window.

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface Box {
    top: number;
    left: number;
    width: number;
    height: number;
}

interface Size {
    width: number;
    height: number;
}

const PAD = 10;
const EDGE = 12;

/**
 * The card's top-left corner: beside the spotlight, then clamped into the viewport so the
 * Back and Next buttons can always be reached.
 *
 * `tip` is the card as rendered. Its height follows the step's text and the font size in
 * Settings, so no fixed estimate holds, and a first run has no Skip to fall back on (#384).
 */
export function placeTip(box: Box, place: Placement, view: Size, tip: Size): { top: number; left: number } {
    let top: number;
    let left: number;
    if (place === 'right' && box.left + box.width + tip.width + 24 < view.width) {
        left = box.left + box.width + PAD;
        top = box.top;
    } else if (place === 'left' && box.left - tip.width - 24 > 0) {
        left = box.left - tip.width - PAD;
        top = box.top;
    } else if (place === 'top' && box.top - tip.height - PAD > 0) {
        top = box.top - tip.height - PAD;
        left = box.left;
    } else {
        // bottom (default); if it would overflow, flip above the target
        top = box.top + box.height + PAD;
        left = box.left;
        if (top + tip.height + EDGE > view.height && box.top - tip.height - PAD > 0) {
            top = box.top - tip.height - PAD;
        }
    }
    // Final guard: keep the whole card on screen.
    return {
        top: Math.max(EDGE, Math.min(top, view.height - tip.height - EDGE)),
        left: Math.max(EDGE, Math.min(left, view.width - tip.width - EDGE)),
    };
}
