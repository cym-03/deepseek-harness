INSERT IGNORE INTO roles (code,name,description,status)
VALUES ('admin_finance','财务专员','财务智能问答与运营维护','active');

INSERT IGNORE INTO role_modules (role_id,module_code,can_view,can_manage)
SELECT r.id,'qa-admin',1,0 FROM roles r WHERE r.code='admin_finance';

INSERT IGNORE INTO operation_audit_logs
(source_key,actor_id,actor_name,action_code,action_name,content,result,resource_type,resource_id,created_at)
SELECT CONCAT('portal:',a.id),COALESCE(a.user_id,'system'),COALESCE(u.name,'系统'),a.action,a.action,
  CONCAT(COALESCE(a.target,'系统配置'),IF(a.metadata IS NULL,'',CONCAT('：',CAST(a.metadata AS CHAR CHARACTER SET utf8mb4)))),
  IF(a.result='success','成功','失败'),'portal',COALESCE(a.target,CAST(a.id AS CHAR)),a.created_at
FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id;
