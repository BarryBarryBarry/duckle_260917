//! #318: evaluate a cron schedule in an explicit IANA time zone.
//!
//! ## Why this is shared code
//!
//! There are two schedulers - the desktop/embedded one in `duckle-scheduler`
//! and the web console's in `duckle-runner`'s `serve` - and they have disagreed
//! about time before. #194 was exactly that: one evaluated cron in UTC and the
//! other in local time, so the same expression fired at two different moments
//! depending on which surface owned it. Both now call in here, so a third
//! implementation cannot quietly appear.
//!
//! ## What a zone changes, and what it does not
//!
//! A cron expression is **civil time**: "0 0 3 * * *" means three in the
//! morning as a person reads a clock. Which instant that is depends on the
//! zone, and on the day, because offsets move. An **interval** schedule is an
//! elapsed duration and is deliberately untouched by any of this: "every 24
//! hours" is 24 hours, not "the same clock time tomorrow", and a zone must not
//! silently turn one into the other.
//!
//! With no zone configured the machine's local zone is used, which is the
//! behaviour #194 settled on and what every existing schedule already means.
//!
//! ## Daylight saving, decided rather than discovered
//!
//! Twice a year a civil time is not a single instant, and a scheduler that has
//! not decided what to do will do something different on each surface, or
//! something different after a restart.
//!
//! - **Nonexistent** (spring forward): 02:30 simply does not happen. The
//!   occurrence is SKIPPED and the next one is taken, rather than being nudged
//!   to 03:30 - a job asked to run at 02:30 on a day with no 02:30 has not been
//!   missed by the scheduler, the day is short. Reported so a caller can hand
//!   it to a misfire policy instead of it vanishing.
//! - **Ambiguous** (autumn back): 02:30 happens twice. The EARLIER instant is
//!   taken, so the job runs once, at the first 02:30. Running twice would be a
//!   duplicate nobody asked for; running at the later one would delay it by an
//!   hour for no reason. The rule is arbitrary but it is written down, tested,
//!   and the same after a restart, which is the property that matters.

use chrono::{DateTime, LocalResult, NaiveDateTime, Offset, TimeZone, Utc};

/// The zone a schedule is evaluated in.
#[derive(Debug, Clone, PartialEq)]
pub enum Zone {
    /// No zone configured: the machine's local zone, as #194 settled.
    Local,
    Named(chrono_tz::Tz),
}

/// Resolve a configured zone name.
///
/// An unknown name is an ERROR, never a silent fall back to local. A schedule
/// that says `Europe/Brussel` (a typo) must not quietly run on UTC in a
/// container and be discovered a quarter later.
pub fn resolve_zone(tz: Option<&str>) -> Result<Zone, String> {
    match tz.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(Zone::Local),
        Some(name) => name.parse::<chrono_tz::Tz>().map(Zone::Named).map_err(|_| {
            format!(
                "unknown time zone {name:?}. Use an IANA name such as Europe/Brussels or \
                 America/New_York, or leave it unset to use the machine's own zone."
            )
        }),
    }
}

/// The `cron` crate expects a 6- or 7-field expression (seconds first). Accept a
/// standard 5-field cron by prepending a zero seconds field.
///
/// Shared so the two schedulers cannot drift: a hand-edited 5-field expression
/// used to parse to None on one surface and silently never fire.
///
/// A 5-field expression is STANDARD crontab, which is what the console and the
/// README tell people to write, and standard crontab numbers weekdays from
/// Sunday = 0. The crate numbers them from Sunday = 1. So the weekday field is
/// translated, not just padded: without that, `0 9 * * 1` - the console's own
/// example for Monday - fired every Sunday, and `1-5` never fired on a Friday.
/// A 6- or 7-field expression is already the crate's own syntax and is left
/// exactly as written, because that is what the desktop schedule builder saves.
pub fn normalize_cron(expr: &str) -> Option<String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    match fields.len() {
        5 => Some(format!(
            "0 {} {} {} {} {}",
            fields[0],
            fields[1],
            fields[2],
            fields[3],
            crontab_weekdays(fields[4])
        )),
        6 | 7 => Some(expr.to_string()),
        _ => None,
    }
}

/// Rewrite a standard crontab weekday field (0 or 7 = Sunday, 1 = Monday) in
/// the cron crate's numbering (1 = Sunday, 2 = Monday).
///
/// Names mean the same in both and pass through, and so do `*` and `*/n`: both
/// numberings START at Sunday, so every n-th day is the same set of days either
/// way. A number, a range or a stepped range is expanded to the days it names
/// and re-emitted as a list - which is also what makes a range through Sunday
/// such as `5-7` expressible at all, since the crate's Sunday is its LOWEST
/// number and a range cannot wrap. Anything this does not recognise, or a number
/// outside 0-7, is left exactly as written so the crate reports its own error
/// against what the user typed.
fn crontab_weekdays(field: &str) -> String {
    field
        .split(',')
        .map(|token| match crontab_days(token) {
            Some(days) => {
                let mut crate_days: Vec<u32> =
                    days.into_iter().map(|d| if d == 0 || d == 7 { 1 } else { d + 1 }).collect();
                crate_days.sort_unstable();
                crate_days.dedup();
                crate_days.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
            }
            None => token.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The crontab day numbers one purely numeric weekday token names - `n`, `a-b`
/// or `a-b/s` - or None for anything else: a name, `*`, `*/n`, `?`, or a shape
/// such as `n/s` whose meaning differs between cron implementations.
fn crontab_days(token: &str) -> Option<Vec<u32>> {
    let (range, step) = match token.split_once('/') {
        Some((range, step)) => (range, Some(step.parse::<usize>().ok().filter(|s| *s > 0)?)),
        None => (token, None),
    };
    let (lo, hi) = match range.split_once('-') {
        Some((a, b)) => (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?),
        None if step.is_some() => return None,
        None => {
            let n = range.parse::<u32>().ok()?;
            (n, n)
        }
    };
    if lo > 7 || hi > 7 || lo > hi {
        return None;
    }
    Some((lo..=hi).step_by(step.unwrap_or(1)).collect())
}

/// Why an occurrence was not the one the expression literally named.
#[derive(Debug, Clone, PartialEq)]
pub enum Adjustment {
    /// The civil time does not exist on that day (spring forward). Skipped.
    NonexistentLocalTime(String),
    /// The civil time happens twice (autumn back). The earlier one was taken.
    AmbiguousLocalTime(String),
    /// A maintenance window or excluded weekday covered it (#296).
    Excluded { at: String, reason: String },
}

/// Days a schedule must not fire on (#296).
///
/// Deliberately small: a weekday list and a date list. Real holiday calendars
/// vary by country, region and year, and a first version that tried to know
/// them would be wrong somewhere and confidently so. A date list is something
/// an operator can verify by reading it.
///
/// Dates are CIVIL dates in the schedule's own zone, which is why this could
/// not sensibly exist before the zone did: "do not run on 2026-12-25" means
/// Christmas where the schedule lives, not a UTC window that clips two
/// different local days.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusions {
    /// Lowercase English weekday names, e.g. ["sunday"].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<String>,
    /// ISO civil dates, e.g. ["2026-12-25"].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dates: Vec<String>,
}

impl Exclusions {
    pub fn is_empty(&self) -> bool {
        self.weekdays.is_empty() && self.dates.is_empty()
    }

    /// Check the lists themselves, so a typo is refused where it is written
    /// rather than silently never matching. "sundy" excluding nothing is
    /// indistinguishable from no exclusion at all until the day arrives.
    pub fn validate(&self) -> Result<(), String> {
        for w in &self.weekdays {
            if weekday_from_name(w).is_none() {
                return Err(format!(
                    "unknown weekday {w:?}. Use an English day name such as sunday."
                ));
            }
        }
        for d in &self.dates {
            if chrono::NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").is_err() {
                return Err(format!("unknown date {d:?}. Use YYYY-MM-DD, e.g. 2026-12-25."));
            }
        }
        Ok(())
    }

    /// Why this civil time is excluded, if it is.
    fn excludes(&self, civil: NaiveDateTime) -> Option<String> {
        use chrono::Datelike;
        let date = civil.date();
        for w in &self.weekdays {
            if weekday_from_name(w) == Some(date.weekday()) {
                return Some(format!("excluded weekday {}", w.trim().to_lowercase()));
            }
        }
        for d in &self.dates {
            if chrono::NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d") == Ok(date) {
                return Some(format!("excluded date {}", d.trim()));
            }
        }
        None
    }
}

fn weekday_from_name(name: &str) -> Option<chrono::Weekday> {
    use chrono::Weekday::*;
    match name.trim().to_ascii_lowercase().as_str() {
        "monday" | "mon" => Some(Mon),
        "tuesday" | "tue" => Some(Tue),
        "wednesday" | "wed" => Some(Wed),
        "thursday" | "thu" => Some(Thu),
        "friday" | "fri" => Some(Fri),
        "saturday" | "sat" => Some(Sat),
        "sunday" | "sun" => Some(Sun),
        _ => None,
    }
}

/// One resolved occurrence.
#[derive(Debug, Clone, PartialEq)]
pub struct Occurrence {
    /// The absolute instant it fires.
    pub at: DateTime<Utc>,
    /// What the clock reads in the schedule's own zone, kept because "03:00
    /// Brussels" is what the operator asked for and the UTC instant is not
    /// recognisable to them.
    pub local: String,
    /// The zone's offset at that instant, in seconds east of UTC.
    pub offset_seconds: i32,
    /// Set when a daylight-saving transition made the literal reading of the
    /// expression impossible or ambiguous.
    pub adjustment: Option<Adjustment>,
}

/// Turn a civil time in `zone` into an instant, deciding the two daylight
/// saving cases rather than letting them decide themselves.
///
/// `Ok(None)` means the civil time does not exist and the caller should take
/// the next occurrence.
fn civil_to_instant<T: TimeZone>(
    zone: &T,
    naive: NaiveDateTime,
) -> (Option<DateTime<Utc>>, Option<Adjustment>)
where
    T::Offset: std::fmt::Display,
{
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(dt) => (Some(dt.with_timezone(&Utc)), None),
        // Twice. Take the first, so the job runs once and always at the same
        // one of the two.
        LocalResult::Ambiguous(earlier, _later) => (
            Some(earlier.with_timezone(&Utc)),
            Some(Adjustment::AmbiguousLocalTime(naive.to_string())),
        ),
        // Never. Skip it rather than inventing a nearby time.
        LocalResult::None => (None, Some(Adjustment::NonexistentLocalTime(naive.to_string()))),
    }
}

/// What the clock reads in `zone` at `at`.
///
/// #296: an occurrence record keeps the local reading because "03:00 Brussels"
/// is what the operator asked for and the UTC instant is not recognisable to
/// them. Formatted here rather than by the caller so a zone is turned into a
/// wall clock in exactly one place, which is the thing this module exists for.
pub fn local_reading(zone: &Zone, at: DateTime<Utc>) -> String {
    match zone {
        Zone::Local => at.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string(),
        Zone::Named(tz) => at.with_timezone(tz).format("%Y-%m-%d %H:%M:%S").to_string(),
    }
}

/// The next occurrence strictly after `after`, evaluated as civil time in
/// `zone`.
///
/// Returns the adjustments that were skipped on the way, so a caller can record
/// "this schedule had no 02:30 today" rather than the occurrence silently
/// disappearing.
pub fn next_after(
    expr: &str,
    zone: &Zone,
    after: DateTime<Utc>,
) -> Result<(Option<Occurrence>, Vec<Adjustment>), String> {
    next_after_excluding(expr, zone, &Exclusions::default(), after)
}

/// [`next_after`], skipping occurrences an exclusion calendar covers (#296).
pub fn next_after_excluding(
    expr: &str,
    zone: &Zone,
    exclusions: &Exclusions,
    after: DateTime<Utc>,
) -> Result<(Option<Occurrence>, Vec<Adjustment>), String> {
    let normalized = normalize_cron(expr)
        .ok_or_else(|| format!("{expr:?} is not a 5, 6 or 7 field cron expression"))?;
    let schedule: cron::Schedule = normalized
        .parse()
        .map_err(|e| format!("cannot parse cron {expr:?}: {e}"))?;
    match zone {
        Zone::Local => walk(&schedule, &chrono::Local, exclusions, after, expr),
        Zone::Named(tz) => walk(&schedule, tz, exclusions, after, expr),
    }
}

/// Enumerate the CIVIL times an expression names, then map each into the zone.
///
/// The enumeration deliberately happens in naive space - the cursor is a naive
/// civil time carried in a `DateTime<Utc>` purely as a vehicle - rather than by
/// asking the cron crate to iterate in the target zone directly. Iterating in
/// the zone hides the interesting case: the crate resolves civil times itself
/// and simply never yields one that does not exist, so a spring-forward gap
/// becomes invisible and cannot be reported. Here the gap is seen, decided, and
/// handed back.
fn walk<T: TimeZone>(
    schedule: &cron::Schedule,
    tz: &T,
    exclusions: &Exclusions,
    after: DateTime<Utc>,
    expr: &str,
) -> Result<(Option<Occurrence>, Vec<Adjustment>), String>
where
    T::Offset: std::fmt::Display,
{
    // A spring-forward gap can only swallow a run of consecutive occurrences,
    // never an unbounded one. The cap is a backstop so an expression naming a
    // civil time that never exists reports rather than hangs.
    const MAX_SKIPS: usize = 512;
    let mut skipped: Vec<Adjustment> = Vec::new();

    let start_civil = after.with_timezone(tz).naive_local();
    let mut cursor: DateTime<Utc> = Utc.from_utc_datetime(&start_civil);

    for _ in 0..MAX_SKIPS {
        let Some(next) = schedule.after(&cursor).next() else {
            return Ok((None, skipped));
        };
        // Its naive part IS the civil time the expression named; the Utc
        // wrapper carried it here and means nothing else.
        let civil = next.naive_utc();
        cursor = next;
        // Checked before the zone maths: a day the operator excluded is
        // excluded whether or not its civil time is also a transition oddity,
        // and reporting "ambiguous" for a day that was never going to run
        // would be a confusing answer to "why did this not fire".
        if let Some(reason) = exclusions.excludes(civil) {
            skipped.push(Adjustment::Excluded { at: civil.to_string(), reason });
            continue;
        }
        let (instant, adjustment) = civil_to_instant(tz, civil);
        match instant {
            Some(at) => {
                let offset_seconds = at.with_timezone(tz).offset().fix().local_minus_utc();
                return Ok((
                    Some(Occurrence {
                        at,
                        local: civil.to_string(),
                        offset_seconds,
                        adjustment,
                    }),
                    skipped,
                ));
            }
            None => skipped.extend(adjustment),
        }
    }
    Err(format!(
        "cron {expr:?} named no civil time that exists in this zone and is not excluded, within \
         {MAX_SKIPS} occurrences. An exclusion calendar that covers every day the expression \
         names would look exactly like this."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap()
    }

    /// A typo must not become "runs on UTC in a container", found a quarter later.
    #[test]
    fn an_unknown_zone_is_refused_rather_than_falling_back() {
        let e = resolve_zone(Some("Europe/Brussel")).unwrap_err();
        assert!(e.contains("Europe/Brussel"), "must name it: {e}");
        assert!(e.contains("IANA"), "must say what a good one looks like: {e}");
        assert_eq!(resolve_zone(None), Ok(Zone::Local));
        assert_eq!(resolve_zone(Some("  ")), Ok(Zone::Local), "blank is unset");
        assert!(matches!(resolve_zone(Some("Europe/Brussels")), Ok(Zone::Named(_))));
    }

    /// The point of the issue: 03:00 Brussels stays 03:00 Brussels wherever the
    /// runner is deployed. In January that is 02:00 UTC.
    #[test]
    fn a_named_zone_fires_at_the_civil_time_it_names() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let (occ, _) = next_after("0 0 3 * * *", &zone, utc(2026, 1, 10, 12, 0)).unwrap();
        let occ = occ.expect("an occurrence");
        assert_eq!(occ.at, utc(2026, 1, 11, 2, 0), "03:00 CET is 02:00 UTC");
        assert_eq!(occ.local, "2026-01-11 03:00:00");
        assert_eq!(occ.offset_seconds, 3600);
    }

    /// And in summer the same expression is a different instant, which is the
    /// whole reason civil time is not a fixed offset.
    #[test]
    fn the_same_expression_is_a_different_instant_in_summer() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let (occ, _) = next_after("0 0 3 * * *", &zone, utc(2026, 7, 10, 12, 0)).unwrap();
        assert_eq!(occ.unwrap().at, utc(2026, 7, 11, 1, 0), "03:00 CEST is 01:00 UTC");
    }

    /// Spring forward: 02:30 does not exist on 2026-03-29 in Brussels. The
    /// occurrence is skipped, not nudged to 03:30, and the skip is reported so
    /// it can be handed to a misfire policy rather than vanishing.
    #[test]
    fn a_nonexistent_civil_time_is_skipped_and_reported() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let (occ, skipped) = next_after("0 30 2 * * *", &zone, utc(2026, 3, 28, 12, 0)).unwrap();
        let occ = occ.expect("an occurrence");
        assert!(
            matches!(skipped.first(), Some(Adjustment::NonexistentLocalTime(_))),
            "the missing 02:30 must be reported, not silently dropped: {skipped:?}"
        );
        assert_eq!(
            occ.local, "2026-03-30 02:30:00",
            "it runs the NEXT day, rather than being nudged to 03:30 on the short day"
        );
    }

    /// Autumn back: 02:30 happens twice on 2026-10-25. It must fire once, at
    /// the earlier of the two, and say that it was ambiguous.
    #[test]
    fn an_ambiguous_civil_time_fires_once_at_the_earlier_instant() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let (occ, _) = next_after("0 30 2 * * *", &zone, utc(2026, 10, 24, 12, 0)).unwrap();
        let occ = occ.expect("an occurrence");
        assert_eq!(occ.local, "2026-10-25 02:30:00");
        // The earlier 02:30 is still CEST (+2), so 00:30 UTC. The later one
        // would be 01:30 UTC.
        assert_eq!(occ.at, utc(2026, 10, 25, 0, 30), "the EARLIER of the two");
        assert!(
            matches!(occ.adjustment, Some(Adjustment::AmbiguousLocalTime(_))),
            "and it must say so: {:?}",
            occ.adjustment
        );
    }

    /// #296: a maintenance window skips the occurrence and says why, rather
    /// than the run merely not appearing.
    #[test]
    fn an_excluded_date_is_skipped_and_reported() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let ex = Exclusions { weekdays: vec![], dates: vec!["2026-12-25".into()] };
        let (occ, skipped) =
            next_after_excluding("0 0 3 * * *", &zone, &ex, utc(2026, 12, 24, 12, 0)).unwrap();
        let occ = occ.expect("an occurrence");
        assert!(
            matches!(skipped.first(), Some(Adjustment::Excluded { .. })),
            "the skipped day must be reported: {skipped:?}"
        );
        assert_eq!(occ.local, "2026-12-26 03:00:00", "it runs the next day instead");
    }

    /// The exclusion is a CIVIL date in the schedule's own zone. 03:00 Brussels
    /// on the 25th is 02:00 UTC on the 25th, but a schedule at 00:30 Brussels
    /// is 23:30 UTC on the 24th - so a UTC-based check would exclude the wrong
    /// day. This is why exclusions could not sensibly exist before zones did.
    #[test]
    fn exclusion_is_by_civil_date_in_the_schedules_own_zone() {
        let zone = resolve_zone(Some("Europe/Brussels")).unwrap();
        let ex = Exclusions { weekdays: vec![], dates: vec!["2026-12-25".into()] };
        // 00:30 Brussels on the 25th is 23:30 UTC on the 24th.
        let (occ, skipped) =
            next_after_excluding("0 30 0 * * *", &zone, &ex, utc(2026, 12, 24, 12, 0)).unwrap();
        assert!(
            matches!(skipped.first(), Some(Adjustment::Excluded { .. })),
            "the 25th local must be excluded even though it is the 24th in UTC: {skipped:?}"
        );
        assert_eq!(occ.unwrap().local, "2026-12-26 00:30:00");
    }

    #[test]
    fn an_excluded_weekday_is_skipped() {
        let zone = resolve_zone(Some("UTC")).unwrap();
        let ex = Exclusions { weekdays: vec!["sunday".into()], dates: vec![] };
        // 2026-12-27 is a Sunday.
        let (occ, skipped) =
            next_after_excluding("0 0 3 * * *", &zone, &ex, utc(2026, 12, 26, 12, 0)).unwrap();
        assert!(matches!(skipped.first(), Some(Adjustment::Excluded { .. })), "{skipped:?}");
        assert_eq!(occ.unwrap().local, "2026-12-28 03:00:00", "Monday instead");
    }

    /// A typo must be refused where it is written. "sundy" excluding nothing is
    /// indistinguishable from no exclusion at all until the day arrives.
    #[test]
    fn a_misspelled_exclusion_is_refused_rather_than_matching_nothing() {
        let bad = Exclusions { weekdays: vec!["sundy".into()], dates: vec![] };
        assert!(bad.validate().unwrap_err().contains("sundy"));
        let bad = Exclusions { weekdays: vec![], dates: vec!["25-12-2026".into()] };
        assert!(bad.validate().unwrap_err().contains("YYYY-MM-DD"));
        let good = Exclusions { weekdays: vec!["Sunday".into()], dates: vec!["2026-12-25".into()] };
        assert!(good.validate().is_ok(), "case and real dates are fine");
    }

    /// An exclusion that covers every day the expression names reports rather
    /// than looping, because a scheduler that hangs is worse than one that
    /// complains.
    #[test]
    fn an_exclusion_covering_everything_is_an_error_not_a_hang() {
        let zone = resolve_zone(Some("UTC")).unwrap();
        let all_week = Exclusions {
            weekdays: vec![
                "monday".into(), "tuesday".into(), "wednesday".into(), "thursday".into(),
                "friday".into(), "saturday".into(), "sunday".into(),
            ],
            dates: vec![],
        };
        assert!(next_after_excluding("0 0 3 * * *", &zone, &all_week, utc(2026, 1, 1, 0, 0)).is_err());
    }

    /// A five-field expression is accepted on both surfaces, or a hand-edited
    /// schedule silently never fires.
    #[test]
    fn five_field_expressions_are_accepted() {
        assert_eq!(normalize_cron("0 3 * * *").as_deref(), Some("0 0 3 * * *"));
        assert_eq!(normalize_cron("0 0 3 * * *").as_deref(), Some("0 0 3 * * *"));
        assert_eq!(normalize_cron("nonsense"), None);
        let zone = resolve_zone(Some("UTC")).unwrap();
        let (occ, _) = next_after("0 3 * * *", &zone, utc(2026, 1, 10, 12, 0)).unwrap();
        assert_eq!(occ.unwrap().at, utc(2026, 1, 11, 3, 0));
    }

    /// A bad expression is an error a caller can report, not a schedule that
    /// quietly never runs.
    #[test]
    fn an_unparseable_expression_is_an_error() {
        let zone = resolve_zone(None).unwrap();
        assert!(next_after("not a cron", &zone, Utc::now()).is_err());
    }

    /// Every weekday a schedule FIRES on across two weeks of occurrences - what
    /// it actually does, not what its text says. A set, because the order the
    /// days arrive in depends on which day the walk starts from, and that is not
    /// the property under test.
    fn fires_on(expr: &str) -> std::collections::BTreeSet<u32> {
        use chrono::Datelike;
        let zone = resolve_zone(Some("UTC")).unwrap();
        let mut after = utc(2026, 9, 13, 0, 0);
        let mut out = std::collections::BTreeSet::new();
        for _ in 0..14 {
            let (occ, _) = next_after(expr, &zone, after).unwrap_or_else(|e| panic!("{expr}: {e}"));
            let occ = occ.unwrap_or_else(|| panic!("{expr}: no occurrence"));
            out.insert(occ.at.weekday().num_days_from_monday());
            after = occ.at;
        }
        out
    }

    fn days(list: &[chrono::Weekday]) -> std::collections::BTreeSet<u32> {
        list.iter().map(|d| d.num_days_from_monday()).collect()
    }

    /// A STANDARD 5-field weekday number is the day it names in crontab.
    ///
    /// The cron crate counts weekdays from Sunday = 1; crontab counts from
    /// Sunday = 0 and also accepts 7 for Sunday. This only prepended a seconds
    /// field, so a 5-field weekday was read in the crate's numbering: `0 9 * * 1`
    /// - the web console's own placeholder for Monday - fired every SUNDAY,
    /// `1-5` fired Sunday to Thursday and never on Friday, and `0` was refused.
    /// Both schedulers normalise through here, so every numbered weekday
    /// schedule fired a day early.
    #[test]
    fn a_five_field_weekday_number_is_the_crontab_day() {
        use chrono::Weekday::*;
        assert_eq!(fires_on("0 9 * * 1"), days(&[Mon]), "1 is Monday");
        assert_eq!(fires_on("0 9 * * 1-5"), days(&[Mon, Tue, Wed, Thu, Fri]), "weekdays");
        assert_eq!(fires_on("0 9 * * 6"), days(&[Sat]), "6 is Saturday");
        assert_eq!(fires_on("0 9 * * 0"), days(&[Sun]), "0 is Sunday");
        assert_eq!(fires_on("0 9 * * 7"), days(&[Sun]), "7 is Sunday too");
        assert_eq!(fires_on("0 9 * * 1,3,5"), days(&[Mon, Wed, Fri]), "a list");
    }

    /// A range that runs through Sunday, which the crate cannot express as a
    /// range at all because its Sunday is the LOWEST number.
    #[test]
    fn a_five_field_range_through_sunday_keeps_every_day_it_names() {
        use chrono::Weekday::*;
        assert_eq!(fires_on("0 9 * * 5-7"), days(&[Fri, Sat, Sun]));
        assert_eq!(fires_on("0 9 * * 0-6"), days(&[Mon, Tue, Wed, Thu, Fri, Sat, Sun]));
    }

    /// Steps. `*/2` names the same days in both numberings, because both ranges
    /// START on Sunday, so it must come through unchanged; a stepped RANGE does
    /// not, and must be translated.
    #[test]
    fn a_five_field_stepped_weekday_is_the_crontab_days() {
        use chrono::Weekday::*;
        assert_eq!(fires_on("0 9 * * */2"), days(&[Sun, Tue, Thu, Sat]), "every other day from Sunday");
        assert_eq!(fires_on("0 9 * * 1-5/2"), days(&[Mon, Wed, Fri]));
    }

    /// What must NOT change. Names mean the same in both numberings, and a 6- or
    /// 7-field expression is already the crate's own syntax - the desktop
    /// schedule builder writes those, and translating them would move every
    /// schedule it ever saved.
    #[test]
    fn names_and_six_field_expressions_are_left_as_written() {
        use chrono::Weekday::*;
        assert_eq!(fires_on("0 9 * * MON-FRI"), days(&[Mon, Tue, Wed, Thu, Fri]));
        assert_eq!(fires_on("0 0 8 * * Mon-Fri"), days(&[Mon, Tue, Wed, Thu, Fri]));
        assert_eq!(fires_on("0 0 9 * * 2"), days(&[Mon]), "6-field 2 is the crate's Monday");
    }

    /// A weekday nothing can mean is still refused, against what the user typed.
    #[test]
    fn a_weekday_out_of_range_is_still_refused() {
        let zone = resolve_zone(Some("UTC")).unwrap();
        assert!(next_after("0 9 * * 8", &zone, utc(2026, 9, 13, 0, 0)).is_err());
    }
}
