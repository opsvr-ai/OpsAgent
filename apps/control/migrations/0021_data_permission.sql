INSERT INTO role_permissions (role_id, permission)
SELECT 'tenant_admin', 'data.manage'
WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'tenant_admin')
ON CONFLICT DO NOTHING;
