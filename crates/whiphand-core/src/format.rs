//! `format.ts`: human-readable sizes and spans, spelled once for every
//! surface that shows them.

use crate::js::{number_to_string, to_fixed};

const KB: f64 = 1024.0;
const MB: f64 = 1024.0 * 1024.0;

/// `1.2 MB`, `340 KB`, `12 B`: one decimal only where it carries information.
pub fn format_bytes(bytes: f64) -> String {
    if bytes >= MB {
        return format!("{} MB", to_fixed(bytes / MB, 1));
    }
    if bytes >= KB {
        // Math.round: halves go up.
        return format!("{} KB", number_to_string((bytes / KB + 0.5).floor()));
    }
    format!("{} B", number_to_string(bytes))
}

/// A span at the coarsest useful precision, seconds floored.
pub fn format_elapsed(ms: f64) -> String {
    let total_seconds = (ms.max(0.0) / 1000.0).floor() as u64;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let total_minutes = total_seconds / 60;
    if total_minutes < 60 {
        return format!("{total_minutes}m {}s", total_seconds % 60);
    }
    format!("{}h {}m", total_minutes / 60, total_minutes % 60)
}

/// `stage 2 of 7 · Add API routes`.
pub fn stage_label(index: &str, total: &str, title: &str) -> String {
    format!("stage {index} of {total} · {title}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes() {
        assert_eq!(format_bytes(12.0), "12 B");
        assert_eq!(format_bytes(1536.0), "2 KB");
        assert_eq!(format_bytes(348_160.0), "340 KB");
        assert_eq!(format_bytes(1_310_720.0), "1.3 MB");
    }

    #[test]
    fn elapsed() {
        assert_eq!(format_elapsed(-5.0), "0s");
        assert_eq!(format_elapsed(61_999.0), "1m 1s");
        assert_eq!(format_elapsed(3_660_000.0), "1h 1m");
    }
}
