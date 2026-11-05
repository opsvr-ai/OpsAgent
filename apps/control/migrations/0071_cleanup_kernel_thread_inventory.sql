DELETE FROM agent_inventory
WHERE kind = 'process' AND (name ~ '^[0-9]' OR name LIKE '%kb');
