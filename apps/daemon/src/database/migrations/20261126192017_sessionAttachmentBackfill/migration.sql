-- Custom SQL migration file, put your code below! --
-- Images sent before the lookup table existed, so their chats still show them. A payload that is not valid
-- JSON, as a crash can leave, is skipped instead of stopping the upgrade.
INSERT OR IGNORE INTO `sessionAttachment` (`id`, `sessionId`, `mediaType`)
SELECT json_extract(`attachment`.`value`, '$.id'), `sessionEvent`.`sessionId`, json_extract(`attachment`.`value`, '$.mediaType')
FROM `sessionEvent`, json_each(CASE WHEN json_valid(`sessionEvent`.`payload`) THEN `sessionEvent`.`payload` ELSE '{}' END, '$.attachments') AS `attachment`
WHERE `sessionEvent`.`type` = 'user.message' AND json_valid(`sessionEvent`.`payload`);
