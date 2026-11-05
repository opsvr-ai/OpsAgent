DELETE FROM agent_inventory
WHERE kind = 'process' AND name LIKE '/%';
