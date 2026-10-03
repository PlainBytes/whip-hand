//! Wall-clock time in the shapes the TS side writes and reads:
//! `Date.now()`, `new Date().toISOString()` and `Date.parse`.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()`: whole milliseconds since the epoch.
pub fn now_ms() -> f64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    since.as_millis() as f64
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    to_iso(now_ms())
}

/// Days since 1970-01-01 to a civil (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `new Date(ms).toISOString()` for the years 0000–9999.
pub fn to_iso(ms: f64) -> String {
    let ms = ms as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

fn digits(s: &str, n: usize) -> Option<(i64, &str)> {
    if s.len() < n || !s.as_bytes()[..n].iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((s[..n].parse().ok()?, &s[n..]))
}

/// `Date.parse` for the ISO date-time format (`YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:mm]]`),
/// which is every timestamp whiphand writes. `None` where JS gives NaN.
///
/// One difference, accepted: JS reads a date-time *without* an offset as
/// local time, and this reads it as UTC. Nothing whiphand writes lacks the `Z`.
pub fn date_parse(s: &str) -> Option<f64> {
    let (year, mut rest) = digits(s, 4)?;
    let (mut month, mut day) = (1, 1);
    if let Some(r) = rest.strip_prefix('-') {
        let (m, r) = digits(r, 2)?;
        month = m;
        rest = r;
        if let Some(r) = rest.strip_prefix('-') {
            let (d, r) = digits(r, 2)?;
            day = d;
            rest = r;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut frac_ms) = (0, 0, 0, 0.0);
    let mut offset_min = 0;
    if let Some(r) = rest.strip_prefix('T') {
        let (hh, r) = digits(r, 2)?;
        let r = r.strip_prefix(':')?;
        let (mm, mut r) = digits(r, 2)?;
        h = hh;
        mi = mm;
        if let Some(r2) = r.strip_prefix(':') {
            let (ss, r3) = digits(r2, 2)?;
            sec = ss;
            r = r3;
            if let Some(r4) = r.strip_prefix('.') {
                let n = r4.bytes().take_while(u8::is_ascii_digit).count();
                if n == 0 {
                    return None;
                }
                let frac: String = r4[..n].chars().take(3).collect();
                frac_ms = format!("{frac:0<3}").parse::<f64>().ok()?;
                r = &r4[n..];
            }
        }
        if let Some(r2) = r.strip_prefix('Z') {
            r = r2;
        } else if let Some(sign) = r.chars().next().filter(|c| *c == '+' || *c == '-') {
            let (oh, r2) = digits(&r[1..], 2)?;
            let r2 = r2.strip_prefix(':')?;
            let (om, r3) = digits(r2, 2)?;
            offset_min = (oh * 60 + om) * if sign == '-' { -1 } else { 1 };
            r = r3;
        }
        if !r.is_empty() || h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0)) {
            return None;
        }
    } else if !rest.is_empty() {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let ms = ((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000;
    Some(ms as f64 + frac_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip() {
        for ms in [0.0, 1_700_000_000_123.0, 951_782_400_000.0, -86_400_000.0] {
            let iso = to_iso(ms);
            assert_eq!(date_parse(&iso), Some(ms), "{iso}");
        }
        assert_eq!(to_iso(1_700_000_000_123.0), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn parse_variants() {
        assert_eq!(date_parse("2024-01-01"), Some(1_704_067_200_000.0));
        assert_eq!(
            date_parse("2024-01-01T01:00:00+01:00"),
            Some(1_704_067_200_000.0)
        );
        assert_eq!(date_parse("nonsense"), None);
        assert_eq!(date_parse("2024-13-01"), None);
    }
}
