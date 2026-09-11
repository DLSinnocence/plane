# MeowAlive 验证（Casdoor OIDC）

Plane 可通过 `https://sso.meowalive.com` 的 Casdoor 服务登录。配置入口为
**God mode → Authentication → MeowAlive 验证**。主站和公开空间均支持该方式。

## 1. 在 Casdoor 创建应用

在 Casdoor 中为 Plane 配置一个服务端 OIDC 应用，使用 **Authorization Code**
授权方式。保留 Client Secret，在服务器端交换令牌；支持 `S256` PKCE。
使用标准 OIDC 身份声明和 **RS256** 签名，签名公钥需要能通过该发行者的 JWKS 发现。
若应用可选令牌格式，使用 `JWT-Standard`。

允许的 scope 为 `openid profile email`。为应用登记以下两个回调地址，**保留末尾 `/`**：

```text
https://task.meowalive.com/auth/meowalive/callback/
https://task.meowalive.com/auth/spaces/meowalive/callback/
```

如果部署域名不同，使用 Plane 配置页显示的回调地址。Casdoor 的 Client ID 和
Client Secret 填到 Plane 后台，不需要写入前端构建变量。

## 2. 配置 Plane

部署包含此功能的新镜像后，访问：

```text
https://task.meowalive.com/god-mode/authentication/meowalive
```

填写以下配置，保存后开启 MeowAlive 验证：

| 配置项        | 值                           |
| ------------- | ---------------------------- |
| Issuer URL    | `https://sso.meowalive.com`  |
| Client ID     | Casdoor 应用的 Client ID     |
| Client secret | Casdoor 应用的 Client Secret |

开启后，普通用户登录页会出现「使用 MeowAlive 验证」。公开空间会使用其独立回调。
God mode 仍使用已有的实例管理员登录方式。

现有实例以后台保存的配置为准。启动时的 `configure_instance` 命令会补齐新配置项，
不覆盖已经保存的值；无需额外数据库迁移。

新安装也可以在 AIO 的 `.env` 中填入以下可选值，由 Compose 传入容器并初始化配置：

```dotenv
IS_MEOWALIVE_ENABLED=1
MEOWALIVE_ISSUER_URL=https://sso.meowalive.com
MEOWALIVE_CLIENT_ID=your-casdoor-client-id
MEOWALIVE_CLIENT_SECRET=your-casdoor-client-secret
```

之后修改已经存在的实例配置，请使用 God mode。仅修改 `.env` 不会覆盖数据库中的
已有认证设置。若曾保存过错误的发行者地址，请在 God mode 将 Issuer URL 改为
`https://sso.meowalive.com` 并保存。

## 3. 验证

1. 保留管理员会话，在另一个浏览器或无痕窗口打开主站。
2. 点击「使用 MeowAlive 验证」，应跳转到 `sso.meowalive.com` 的授权页面。
3. 登录授权后，应回到 Plane 并建立用户会话。
4. 如使用公开空间，再测试一次空间登录入口和其回调。

邮箱用于匹配 Plane 中已有账户，因此 Casdoor 必须明确返回已验证邮箱：
UserInfo 的 `email_verified` 为布尔值 `true`；或者 UserInfo 未提供该字段时，
已验签的 ID token 中 `email_verified=true` 且 `email` 与 UserInfo 一致。
明确未验证的 UserInfo 不会被 ID token 覆盖。缺少验证标志、字符串 `"true"`
或未验证邮箱都会被拒绝。新账户仍遵循 Plane 的注册开关和邀请限制。

Plane 会校验 discovery issuer、令牌签名、issuer、audience、有效期、nonce、
UserInfo subject，以及一次性的会话 state。配置的 OIDC 端点须与 issuer 使用相同
HTTPS origin；令牌交换使用 PKCE，且不会跟随携带凭据请求的重定向。

## 4. 排查连接问题

无需登录即可在浏览器访问：

```text
https://sso.meowalive.com/.well-known/openid-configuration
```

它应返回 OIDC JSON，`issuer` 必须与配置值一致，并包含授权、令牌、UserInfo 和
JWKS 地址。Plane 的 API 容器也必须能通过正常 TLS 校验访问这些地址。

已确认正确地址 `https://sso.meowalive.com` 的发现端点可通过浏览器和后端 OIDC
客户端的正常证书校验，JWKS 也已成功返回公钥。返回的 `issuer` 与上述地址一致，
并声明支持 Authorization Code、S256 PKCE 和 RS256。
发现端点连通性不代表已经完成真实登录；后续仍需配置应用凭据并验证完整授权回调。

仅修改本仓库不会更新已发布的 `preview` 镜像。需要构建并发布包含新后端、主站、
空间和管理前端的 AIO 镜像，然后升级部署。升级后，保留原有 `.env` 和数据卷。

相关规范与 Casdoor 配置说明：
[Casdoor 标准 OIDC 客户端](https://casdoor.org/docs/how-to-connect/oidc-client/)。
