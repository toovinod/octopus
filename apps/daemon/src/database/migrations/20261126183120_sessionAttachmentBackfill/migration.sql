-- Custom SQL migration file, put your code below! --
-- Images sent before the lookup table existed, so their chats still show them.
INSERT OR IGNORE INTO `sessionAttachment` (`id`, `sessionId`, `mediaType`)
SELECT json_extract(`attachment`.`value`, '$.id'), `sessionEvent`.`sessionId`, json_extract(`attachment`.`value`, '$.mediaType')
FROM `sessionEvent`, json_each(`sessionEvent`.`payload`, '$.attachments') AS `attachment`
WHERE `sessionEvent`.`type` = 'user.message';
