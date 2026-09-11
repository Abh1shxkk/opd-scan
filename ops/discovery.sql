/* ============================================================================
   OPD Scan — discovery queries for the .NET/PACS SQL Server database
   ============================================================================

   PURPOSE
     Answers the open questions blocking the intake-port and migration plan.

   SAFETY
     Every statement below is a SELECT. Nothing is written, altered or deleted.

   PRIVACY
     Written so the output carries NO patient names and NO passwords — only
     lengths, counts, formats and masked samples. Run it, then share the result
     grids. If any output still shows something identifying, mask it before
     sending.

   HOW TO RUN
     SSMS (or Azure Data Studio) -> connect to the PACS database -> open this
     file -> run section by section (each section is numbered) so the result
     grids stay separate and readable.
   ============================================================================ */


/* ---------------------------------------------------------------------------
   1. Every table in the database, with row counts.
      Why: the structure dump had 19 tables and a "MatterID" column with no
      matching Matter table — so either a table is missing from that dump or
      the column is legacy. This settles it, and the row counts size the
      migration.
   --------------------------------------------------------------------------- */
SELECT
    s.name                       AS [schema],
    t.name                       AS [table],
    SUM(p.rows)                  AS [row_count]
FROM sys.tables t
JOIN sys.schemas s      ON s.schema_id = t.schema_id
JOIN sys.partitions p   ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY [row_count] DESC, t.name;


/* ---------------------------------------------------------------------------
   2. Declared foreign keys.
      Why: the dump showed none. If the real database has them, they answer
      the "how does a file link to a patient" question outright.
   --------------------------------------------------------------------------- */
SELECT
    fk.name                                   AS fk_name,
    OBJECT_NAME(fk.parent_object_id)          AS from_table,
    cp.name                                   AS from_column,
    OBJECT_NAME(fk.referenced_object_id)      AS to_table,
    cr.name                                   AS to_column
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id     AND cp.column_id = fkc.parent_column_id
JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
ORDER BY from_table, from_column;


/* ---------------------------------------------------------------------------
   3. BLOCKER 1 — how is an uploaded file tied to a patient?
      FileDetails has no STID. It has MatterID, UID and FullPath. One of those
      must carry the link (or the link lives in the folder structure).
      Patient-identifying columns are deliberately not selected.
   --------------------------------------------------------------------------- */

-- 3a. Shape of the columns that could carry the link.
SELECT
    COUNT(*)                                          AS total_files,
    COUNT(MatterID)                                   AS matterid_not_null,
    COUNT(DISTINCT MatterID)                          AS matterid_distinct,
    MIN(MatterID)                                     AS matterid_min,
    MAX(MatterID)                                     AS matterid_max,
    COUNT(UID)                                        AS uid_not_null,
    COUNT(DISTINCT UID)                               AS uid_distinct,
    COUNT(OurSubmission)                              AS oursubmission_not_null,
    COUNT(DISTINCT OurSubmission)                     AS oursubmission_distinct
FROM dbo.FileDetails;

-- 3b. What FullPath actually looks like (folder convention may hold the link).
--     Only the directory part is shown, filename dropped, in case the filename
--     contains a patient name.
SELECT TOP 20
    FID,
    FileType,
    FStatus,
    FSize,
    EDate,
    UID,
    MatterID,
    LEFT(FullPath, LEN(FullPath) - CHARINDEX('\', REVERSE(FullPath))) AS folder_only,
    LEN(FileName)                                                     AS filename_length
FROM dbo.FileDetails
WHERE FullPath IS NOT NULL
ORDER BY FID DESC;

-- 3c. Do MatterID values line up with PatientDetails.STID?
--     If overlap_count > 0, MatterID is very likely the patient/study link.
SELECT
    (SELECT COUNT(*) FROM dbo.FileDetails    WHERE MatterID IS NOT NULL)              AS files_with_matterid,
    (SELECT COUNT(*) FROM dbo.PatientDetails)                                          AS patient_rows,
    (SELECT COUNT(*)
       FROM dbo.FileDetails f
       JOIN dbo.PatientDetails p ON CAST(f.MatterID AS nvarchar(255)) = p.STID)        AS overlap_matterid_to_stid;

-- 3d. Distinct file types and statuses — tells us what actually needs migrating.
SELECT FileType, FStatus, COUNT(*) AS cnt
FROM dbo.FileDetails
GROUP BY FileType, FStatus
ORDER BY cnt DESC;


/* ---------------------------------------------------------------------------
   4. BLOCKER 2 — password storage format.
      IMPORTANT: this deliberately does NOT return any password value.
      It returns only the length and a character-class guess, which is all
      that is needed to decide the migration strategy.
        len 32 + hex        -> MD5      -> users must reset
        len 40 + hex        -> SHA1     -> users must reset
        len 60 starting $2  -> bcrypt   -> can be carried over as-is
        short / mixed case  -> plaintext-> can be bcrypt'd during migration
   --------------------------------------------------------------------------- */
SELECT
    LEN(pass)                                                           AS pass_length,
    COUNT(*)                                                            AS user_count,
    MAX(CASE WHEN pass LIKE '$2%'                       THEN 1 ELSE 0 END) AS looks_like_bcrypt,
    MAX(CASE WHEN pass NOT LIKE '%[^0-9a-fA-F]%'        THEN 1 ELSE 0 END) AS is_all_hex,
    MAX(CASE WHEN pass LIKE '%[^0-9a-zA-Z]%'            THEN 1 ELSE 0 END) AS has_symbols
FROM dbo.Login
GROUP BY LEN(pass)
ORDER BY user_count DESC;

-- Same for the Radiologix login table, if that is the one actually in use.
SELECT
    LEN(pass)                                                           AS pass_length,
    COUNT(*)                                                            AS user_count,
    MAX(CASE WHEN pass LIKE '$2%'                       THEN 1 ELSE 0 END) AS looks_like_bcrypt,
    MAX(CASE WHEN pass NOT LIKE '%[^0-9a-fA-F]%'        THEN 1 ELSE 0 END) AS is_all_hex
FROM dbo.LoginRadiologix
GROUP BY LEN(pass)
ORDER BY user_count DESC;

-- Which login table is live? Compare counts and most recent activity.
SELECT 'Login' AS src, COUNT(*) AS rows_total, MAX(UE_date) AS last_touched FROM dbo.Login
UNION ALL
SELECT 'LoginRadiologix', COUNT(*), MAX(UE_date) FROM dbo.LoginRadiologix
UNION ALL
SELECT 'LoginDetails', COUNT(*), NULL FROM dbo.LoginDetails;


/* ---------------------------------------------------------------------------
   5. BLOCKER 3 — date columns stored as text.
      StudyDateTime is nvarchar(255). Different string lengths almost always
      mean different formats, each needing its own parse rule.
   --------------------------------------------------------------------------- */
SELECT
    LEN(StudyDateTime)      AS text_length,
    COUNT(*)                AS cnt,
    MIN(StudyDateTime)      AS example_min,
    MAX(StudyDateTime)      AS example_max
FROM dbo.PatientDetails
WHERE StudyDateTime IS NOT NULL
GROUP BY LEN(StudyDateTime)
ORDER BY cnt DESC;

-- How many rows would fail a straight datetime conversion.
SELECT
    COUNT(*)                                                        AS total_rows,
    SUM(CASE WHEN TRY_CONVERT(datetime2, StudyDateTime) IS NULL
             AND StudyDateTime IS NOT NULL THEN 1 ELSE 0 END)        AS unparseable_rows
FROM dbo.PatientDetails;


/* ---------------------------------------------------------------------------
   6. BLOCKER 4 — is the Gemini key per-user or effectively system-wide?
      The key value itself is NOT selected.
   --------------------------------------------------------------------------- */
SELECT
    COUNT(*)                                                        AS total_users,
    COUNT(GeminiKey)                                                AS users_with_a_key,
    COUNT(DISTINCT GeminiKey)                                       AS distinct_keys,
    SUM(CASE WHEN CanRevert = 1 THEN 1 ELSE 0 END)                  AS users_with_revert
FROM dbo.LoginRadiologix;


/* ---------------------------------------------------------------------------
   7. BLOCKER 5 — volume, for sizing the migration.
   --------------------------------------------------------------------------- */
SELECT
    (SELECT COUNT(*) FROM dbo.PatientDetails)      AS patients,
    (SELECT COUNT(*) FROM dbo.FileDetails)         AS files,
    (SELECT COUNT(*) FROM dbo.Login)               AS users_login,
    (SELECT COUNT(*) FROM dbo.LoginRadiologix)     AS users_radiologix,
    (SELECT COUNT(*) FROM dbo.PLocations)          AS locations,
    (SELECT COUNT(*) FROM dbo.LocationPermission)  AS location_permissions,
    (SELECT COUNT(*) FROM dbo.StudiesReport)       AS reports,
    (SELECT COUNT(*) FROM dbo.StudyLog)            AS study_log_rows;

-- Total size of stored files, as recorded in the table.
-- NOTE: FSize is nvarchar, so this only works if it holds plain numbers.
--       If it errors or returns NULL, say so — it means FSize has units
--       ("2.3 MB") and the real sizes have to come from the filesystem.
SELECT
    COUNT(*)                                           AS rows_counted,
    SUM(TRY_CONVERT(bigint, FSize))                    AS total_bytes_if_numeric,
    MIN(FSize)                                         AS example_low,
    MAX(FSize)                                         AS example_high
FROM dbo.FileDetails;


/* ---------------------------------------------------------------------------
   8. Column inventory for the four tables being ported.
      Why: gives exact types/lengths/nullability so the Postgres columns match
      instead of being guessed.
   --------------------------------------------------------------------------- */
SELECT
    TABLE_NAME,
    COLUMN_NAME,
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH  AS max_len,
    IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('PatientDetails', 'FileDetails', 'Login', 'LoginRadiologix',
                     'PLocations', 'LocationPermission', 'UserProfileDetails')
ORDER BY TABLE_NAME, ORDINAL_POSITION;


/* ---------------------------------------------------------------------------
   9. One masked sample row per ported table.
      Names/IDs are reduced to first character + length so the shape is visible
      without exposing the value.
   --------------------------------------------------------------------------- */
SELECT TOP 5
    STID,
    LEFT(PatientName, 1) + '***(' + CAST(LEN(PatientName) AS varchar) + ')' AS name_masked,
    LEFT(PatientID, 2)   + '***'                                            AS patientid_masked,
    PatientSex,
    PatientAge,
    LEFT(ReferralDr, 1)  + '***'                                            AS referral_masked,
    StudyDateTime,
    UpdatedAt
FROM dbo.PatientDetails
ORDER BY UpdatedAt DESC;
