# 停车券自动扣费工具（H5 + Python 后台骨架）

这是一个可直接本地跑起来的前后台版本结构，适合你先做完整流程测试：
- H5 手机页面
- 账号池管理
- 金额输入
- 预览确认
- 自动按 25 元拆轮
- 按最少账号原则分配扣券
- 任务记录与月度统计

## 重要说明
这版**没有**实现针对第三方站点的真实自动登录与自动操作。
我保留了：
- 目标链接配置
- 执行模式切换
- 后端执行适配器接口
- mock 可测试流程

真实第三方执行器需要你在**获得批准的官方接口**或你自建的合规执行服务里接入，替换 `ApprovedIntegrationOnlyAdapter` 即可。

## 目录
- `server.py`：后端 API + 静态文件服务
- `frontend/`：H5 页面
- `data/`：SQLite 数据库、Fernet 密钥

## 运行
```bash
cd parking_coupon_fullstack
python server.py
```

默认地址：
- http://127.0.0.1:8000
- 局域网内可用 `http://你的电脑IP:8000`

## 执行模式
- `mock`：直接可测，执行时会成功扣减本地券数
- `approved_integration_only`：只保留任务流，不会真正执行

## 安全
- 账号密码使用 Fernet 对称加密存储到 SQLite
- 首次启动会在 `data/fernet.key` 生成密钥
- 部署时建议通过环境变量 `APP_FERNET_KEY` 提供你自己的密钥

## 后续接真实执行器
你可以在 `server.py` 里新增一个适配器类，例如：
- `OfficialApiAdapter`
- `ManualBrowserBridgeAdapter`

然后在 `AppService.adapters` 中注册。

## 当前适合做什么
- 手机流程验证
- 页面与交互确认
- 账号池/拆轮/预览/确认/记录逻辑确认
- 后端 API 联调

## 不适合做什么
- 直接对第三方网页做自动登录和批量操作
