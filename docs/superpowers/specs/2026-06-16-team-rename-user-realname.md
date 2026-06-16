# 团队改名 + 用户真实姓名字段 设计

日期:2026-06-16。状态:用户已提需求,设计默认值已定。

## 目标

1. 团队名称可在管理台修改(当前只能创建时定名,无改名入口)。
2. 用户新增「真实姓名」字段,创建时可选填、之后可改(管理台)。

## 1. 团队改名

- 后端 `src/admin/teams.rs`:`/teams/:id` 路由追加 `.patch(update)`,新增 handler `update`:
  - Body `{ name: String }`;`name.trim()` 非空(复用文案「团队名称不能为空」)。
  - `UPDATE teams SET name = ? WHERE id = ?`;`rows_affected() == 0` → 404「团队不存在」。
  - 审计 `team.update`,detail `{"name": name}`。`AdminUser` 鉴权。
  - 返回更新后的 `TeamRow`(含 member_count,与 create 返回形状一致,需带 COUNT 子查询回读)。
- 前端 `admin-ui/src/lib/api.ts`:`teams.update(id, { name })` → `patch<Team>`。
- 前端 `admin-ui/src/pages/Teams.tsx`:列表「操作」列在「进入详情」旁加「重命名」按钮,打开弹窗(复用新建弹窗的 Input+Modal 结构),提交调 `teams.update` 后 `load()`。

## 2. 用户真实姓名

- 迁移 `migrations/0003_user_real_name.sql`(新文件,版本号递增,不改旧迁移):
  ```sql
  ALTER TABLE users ADD COLUMN real_name TEXT NOT NULL DEFAULT '';
  ```
  选 `NOT NULL DEFAULT ''`(非可空):避免「未填」与「改成 null」歧义,与 users.rs 审计纪律一致。
- 后端 `src/admin/users.rs`:
  - `UserRow` 加 `real_name: String`;list 的 SELECT 补 `real_name`。
  - `CreateReq` 加 `#[serde(default)] real_name: Option<String>`;`trim`,缺省 `""`;INSERT 补 real_name。
  - `UpdateReq` 加 `real_name: Option<String>`;「无字段」守护 `status.is_none() && role.is_none()` 改为也判 real_name;
    `UPDATE ... real_name = COALESCE(?, real_name) ...`(传 `Some("")` 可清空,传 None 不动——语义正确);
    审计 detail 仅在字段出现时放入(`"real_name": req.real_name`);回读 SELECT 补 real_name。
- 前端 `admin-ui/src/lib/api.ts`:`User` 接口加 `real_name: string`;`users.create` body 加 `real_name?`;`users.update` body 加 `real_name?`。
- 前端 `admin-ui/src/pages/Users.tsx`:
  - 表格加「真实姓名」列(空值显示占位如 `—`)。
  - 新建弹窗加「真实姓名」Input(选填)。
  - 加编辑入口:操作列加「编辑」按钮,弹窗改 real_name,提交 `users.update`。

## 红线

- 迁移已合入 main 的文件一字节不改;只新增 0003。
- 不动网关面、guide 接入页、CSP。
- `password_hash` 绝不进 UserRow / 任何返回。
- 审计 detail 不记任何密钥/凭证/密码。

## 测试

- Rust(扩充 users.rs / teams.rs 内联 tests):
  - 用户:create 带 real_name 落库并回显;list 含 real_name;update real_name(含清空为 `""`);只传 real_name 不再触发「没有需要更新的字段」。
  - 团队:rename 成功回显;空名 400;不存在 404;审计落 `team.update`。
- 迁移测试 `migrations_create_all_tables` 仍须绿(0003 自动执行)。
- 三件套:`cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked` 全绿;admin-ui `tsc --noEmit && vite build` 通过。

## 交付物

`migrations/0003_user_real_name.sql`(新)、`src/admin/teams.rs`、`src/admin/users.rs`、`admin-ui/src/lib/api.ts`、`admin-ui/src/pages/Teams.tsx`、`admin-ui/src/pages/Users.tsx`。
