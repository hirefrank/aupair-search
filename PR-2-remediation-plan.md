# PR #2 Remediation Plan

## Recommendation

Do not merge PR #2 as-is.

The field-access helper direction is good, but the current patch still leaves APIA effectively unusable under the default config, and its auth-alert routing is not reliable. The next revision should separate the data-access cleanup from the matching-policy changes and make the source-specific behavior explicit.

## Plan

1. Split the work into two logical changes.
   - Change A: add source-aware field access helpers (`rawDetail`, `rawField`, `rawStringField`) and Slack payload fallbacks.
   - Change B: change hard-filter behavior for APIA.
   - This keeps the refactor reviewable and makes any filter-policy changes intentional.

2. Make APIA detail fetch a prerequisite for detail-only hard filters.
   - `MATCH_REQUIRE_FEMALE=true` cannot work for APIA when `APIA_FETCH_DETAILS=false`, because `genderIdentity` only exists in APIA detail pages.
   - The same constraint applies to other detail-only fields such as `petAllergies`, `swimmer`, and `driverLicenseReceivedOn`.
   - Pick one of these approaches and implement it explicitly:
   - Auto-enable APIA detail fetch when APIA is enabled.
   - Fail fast with a clear skipped reason when APIA is enabled alongside hard filters that require detail-only fields.
   - Relax specific filters for APIA, but only after deciding that unknown data is acceptable for those filters.

3. Replace regex-based auth classification with structured adapter errors.
   - Add an explicit `errorCode` or equivalent typed reason to adapter results, for example:
   - `culturecare_auth`
   - `apia_auth`
   - `generic_fetch_error`
   - Use those structured values in `worker.ts` instead of parsing free-form error strings.
   - This avoids sending the wrong provider alert and avoids missing known APIA auth failures such as anti-forgery token errors.

4. Decide the policy for missing data per criterion and per source.
   - For each hard filter, explicitly decide whether missing data means `reject`, `skip check`, or `fallback to another field`.
   - Cover at least these criteria:
   - English level
   - Child ages
   - Pets / dog compatibility
   - Driving frequency
   - Driving years
   - Swimming supervision
   - Lived away from home
   - Do not apply APIA relaxations to CultureCare by accident. If a relaxation is meant to be APIA-only, branch on `profile.source` or on a source capability flag.

5. Add focused regression tests before merging.
   - APIA profile without detail data and `MATCH_REQUIRE_FEMALE=true`.
   - APIA profile with detail data that satisfies the female filter.
   - APIA auth failure produces only the APIA alert.
   - CultureCare auth failure still produces only the CultureCare alert.
   - CultureCare missing-field behavior remains unchanged unless explicitly intended.
   - Source-aware fallback helpers read top-level and nested detail fields in the expected order.

6. Update configuration docs after behavior is finalized.
   - `.env.example` should reflect whether `APIA_FETCH_DETAILS` must be `true` for production use.
   - README should explain which APIA filters are strict, which are best-effort, and which require detail fetch.

## Suggested Implementation Order

1. Land the source-aware field helper refactor with tests.
2. Add structured adapter error codes and worker alert routing.
3. Implement explicit APIA filter policy with either mandatory detail fetch or source-specific relaxations.
4. Add regression tests for APIA and CultureCare hard filters.
5. Re-review the PR after those changes and only then merge.

## Acceptance Criteria

- Enabling APIA with the documented production config results in APIA candidates being eligible for matching.
- No APIA auth failure can trigger a CultureCare auth alert.
- No CultureCare auth failure can trigger an APIA auth alert.
- Hard-filter behavior is explicit and test-covered for both sources.
- The final PR states clearly which filters are strict and which are best-effort when data is unavailable.
