//! Wire-timestamp parsing for `PeerInfo.updated_at`. Tolerant ISO-8601 reader
//! reduced to unix-seconds for ordered comparison.

use crate::sync::error::SyncError;

/// Parsed peer-list `updated_at` reduced to unix-seconds for ordered comparison.
///
/// Tolerates trailing `Z`, fractional seconds, and `+00:00`/`-00:00` offsets. The
/// minimum parseable form is `YYYY-MM-DDTHH:MM:SS`. Anything else returns
/// `SyncError::BadTimestamp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PeerTimestamp(pub u64);

impl PeerTimestamp {
    pub fn parse(s: &str) -> std::result::Result<Self, SyncError> {
        let bad = || SyncError::BadTimestamp { raw: s.to_string() };

        let s = s.trim();
        if s.is_empty() {
            return Err(bad());
        }

        // Minimum: YYYY-MM-DDTHH:MM:SS (19 bytes). A valid header is pure ASCII,
        // so byte 19 must be a char boundary — a multibyte char straddling it is
        // invalid input, not a panic (this value is peer-controlled).
        if s.len() < 19 || !s.is_char_boundary(19) {
            return Err(bad());
        }

        let head = &s[..19];
        let tail = &s[19..];

        let bytes = head.as_bytes();
        if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
            return Err(bad());
        }
        let year: i64 = head[0..4].parse().map_err(|_| bad())?;
        let month: u32 = head[5..7].parse().map_err(|_| bad())?;
        let day: u32 = head[8..10].parse().map_err(|_| bad())?;
        let hour: u32 = head[11..13].parse().map_err(|_| bad())?;
        let minute: u32 = head[14..16].parse().map_err(|_| bad())?;
        let second: u32 = head[17..19].parse().map_err(|_| bad())?;

        // Parse the tail: optional fractional, then optional zone (Z or ±HH:MM).
        let mut rest = tail;
        if let Some(stripped) = rest.strip_prefix('.') {
            let frac_end = stripped
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(stripped.len());
            if frac_end == 0 {
                return Err(bad());
            }
            rest = &stripped[frac_end..];
        }

        // Time zone offset in seconds (positive east of UTC).
        let zone_offset_secs: i64 = if rest.is_empty() {
            // No zone -> assume UTC. Plenty of producers omit Z; match `chrono::DateTime::parse_from_rfc3339`
            // behaviour of *requiring* one, but we treat the lack as UTC for forward compat. This is
            // a known relaxation; see PeerTimestamp tests.
            0
        } else if rest == "Z" || rest == "z" {
            0
        } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && rest.as_bytes()[3] == b':' {
            let sign: i64 = if rest.starts_with('-') { -1 } else { 1 };
            let oh: i64 = rest[1..3].parse().map_err(|_| bad())?;
            let om: i64 = rest[4..6].parse().map_err(|_| bad())?;
            sign * (oh * 3600 + om * 60)
        } else {
            return Err(bad());
        };

        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
            return Err(bad());
        }

        // Days from civil (Howard Hinnant's algorithm).
        // Returns days since 1970-01-01 for a given year/month/day.
        let y = if month <= 2 { year - 1 } else { year };
        let era = (if y >= 0 { y } else { y - 399 }) / 400;
        let yoe = (y - era * 400) as u64;
        let doy: u64 = (153 * (if month > 2 { month - 3 } else { month + 9 }) as u64 + 2) / 5
            + day as u64
            - 1;
        let doe: u64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days_since_epoch: i64 = era * 146_097 + doe as i64 - 719_468;

        let total_secs: i64 = days_since_epoch * 86_400
            + hour as i64 * 3600
            + minute as i64 * 60
            + second as i64
            - zone_offset_secs;
        if total_secs < 0 {
            return Err(bad());
        }
        Ok(PeerTimestamp(total_secs as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_utc() {
        assert!(PeerTimestamp::parse("2026-07-10T12:00:00Z").is_ok());
    }

    #[test]
    fn rejects_multibyte_char_at_byte_boundary_without_panic() {
        // 18 ASCII bytes + 'é' (2 bytes) => byte 19 falls inside the char.
        // The peer-controlled value must be rejected, not panic the daemon.
        let s = "2026-07-10T12:00:0é";
        assert_eq!(s.len(), 20); // 18 + 2
        assert!(!s.is_char_boundary(19));
        assert!(PeerTimestamp::parse(s).is_err());
    }

    #[test]
    fn rejects_leading_multibyte() {
        // A multibyte string that is >= 19 bytes but garbage.
        assert!(PeerTimestamp::parse("日本語日本語日本語日本語").is_err());
    }
}
