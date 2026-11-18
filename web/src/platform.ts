const LOCAL_HOSTNAMES = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const IS_TOUCH_DEVICE = window.matchMedia("(pointer: coarse)").matches;
export const SHORTCUT_PREFIX = IS_MAC ? "⌘" : "Ctrl+";
export const SIGN_OUT_URL = LOCAL_HOSTNAMES.test(location.hostname) ? null : "/cdn-cgi/access/logout";
