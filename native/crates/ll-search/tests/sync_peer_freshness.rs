use ll_search::sync::protocol::PeerTimestamp;

#[test]
fn parse_iso_z() {
    let t = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    // unix seconds for 2026-05-11T12:00:00Z = 1778500800 (precomputed)
    assert_eq!(t.0, 1778500800);
}

#[test]
fn parse_iso_with_millis_equal() {
    let with_z = PeerTimestamp::parse("2026-05-11T12:00:00.000Z").unwrap();
    let without = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    assert_eq!(with_z, without);

    let with_millis = PeerTimestamp::parse("2026-05-11T12:00:00.456Z").unwrap();
    // Fractional seconds are stripped, so .456 collapses to the same whole-second value.
    assert_eq!(with_millis, without);
}

#[test]
fn parse_iso_with_offset() {
    // 12:00 at +02:00 = 10:00 UTC
    let plus_two = PeerTimestamp::parse("2026-05-11T12:00:00+02:00").unwrap();
    let utc = PeerTimestamp::parse("2026-05-11T10:00:00Z").unwrap();
    assert_eq!(plus_two, utc);

    let minus_three = PeerTimestamp::parse("2026-05-11T09:00:00-03:00").unwrap();
    let utc_noon = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    assert_eq!(minus_three, utc_noon);
}

#[test]
fn parse_no_zone_assumes_utc() {
    let no_zone = PeerTimestamp::parse("2026-05-11T12:00:00").unwrap();
    let utc = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    assert_eq!(no_zone, utc);
}

#[test]
fn parse_rejects_garbage() {
    assert!(PeerTimestamp::parse("").is_err());
    assert!(PeerTimestamp::parse("not-a-date").is_err());
    assert!(PeerTimestamp::parse("2026/05/11 12:00:00").is_err());
    assert!(PeerTimestamp::parse("2026-13-01T00:00:00Z").is_err()); // month 13
    assert!(PeerTimestamp::parse("2026-05-11T24:00:00Z").is_err()); // hour 24
    assert!(PeerTimestamp::parse("2026-05-11T12:60:00Z").is_err()); // minute 60
}

#[test]
fn parse_ordering() {
    let a = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    let b = PeerTimestamp::parse("2026-05-11T12:00:01Z").unwrap();
    let c = PeerTimestamp::parse("2026-05-12T00:00:00Z").unwrap();
    assert!(a < b);
    assert!(b < c);
    assert!(c.0 - a.0 == 43200);
}

#[test]
fn parse_lowercase_z_accepted() {
    let lower = PeerTimestamp::parse("2026-05-11T12:00:00z").unwrap();
    let upper = PeerTimestamp::parse("2026-05-11T12:00:00Z").unwrap();
    assert_eq!(lower, upper);
}
