# Amazon Bedrock PR Review Bot

Amazon Bedrock을 활용한 자동 PR 리뷰 서버리스 애플리케이션입니다. AWS CDK로 구축되었으며, GitHub, GitLab, Bitbucket과 통합되어 Slack 알림과 함께 상세한 코드 리뷰를 제공합니다.

## 아키텍처

![아키텍처 다이어그램](docs/img/architecture.png)

사용된 AWS 서비스:
- Amazon API Gateway: 웹훅 엔드포인트
- AWS Step Functions: 워크플로우 오케스트레이션
- AWS Lambda: 서버리스 컴퓨팅
- Amazon Bedrock: AI 기반 코드 리뷰
- AWS Secrets Manager와 Parameter Store: 설정 관리
- Amazon CloudWatch: 모니터링 및 로깅

## 사전 요구사항

- AWS 계정 (적절한 권한 필요) / 현재 ap-northeast-2 리전에서만 정상적으로 동작합니다.
- Node.js 18.x 이상
- Python 3.12
- AWS CDK CLI v2.x
- Git
- Amazon Bedrock 접근 권한
- 액세스 토큰:
  - GitHub/GitLab/Bitbucket (사용하는 저장소에 따라)
  - Slack (알림용)

## 설치 방법

1. 저장소 클론:
```bash
git clone https://github.com/muylucir/amazon-bedrock-pr-review-bot.git
cd amazon-bedrock-pr-review-bot
```

2. 의존성 설치:
```bash
npm install
```

3. Lambda Layer 생성를 위한 준비
```bash
chmod +x setup-layer.sh
./setup-layer.sh
```

setup-layer.sh는 Python 3.12버전을 사용하는 것을 명시하도록 pip3.12 명령어가 지정되어 있습니다. 이미 Python 3.12을 사용하고 있다면 아래와 같이 수정합니다. 

```bash
vi setup-layer.sh

#!/bin/bash
# setup-layers.sh

# Requests Layer
echo "Setting up requests layer..."
mkdir -p layer/requests/python
cd layer/requests/python
pip3 install requests -t .
cd ../../..

# Networkx Layer
echo "Setting up networkx layer..."
mkdir -p layer/networkx/python
cd layer/networkx/python
pip3 install networkx numpy -t .
cd ../../..

# Clean up unnecessary files
find layer -type d -name "__pycache__" -exec rm -rf {} +
find layer -type d -name "*.dist-info" -exec rm -rf {} +
find layer -type d -name "*.egg-info" -exec rm -rf {} +
find layer -type f -name "*.pyc" -delete

echo "Layer setup complete!"
```


## 배포

1. AWS 환경 부트스트랩 (처음 한 번만):
```bash
cdk bootstrap
```

2. 스택 배포:
```bash
cdk deploy
```

3. Secret Manager에 Token을 실제 값으로 Update (해당하는 Repository만 실행하면 됩니다.)
```bash
# GitHub : Personal access tokens (classic)만 지원합니다.
aws secretsmanager update-secret \
  --secret-id /pr-reviewer/tokens/github \
  --secret-string '{"access_token":"input-your-actual-token"}'

# GitLab
aws secretsmanager update-secret \
  --secret-id /pr-reviewer/tokens/gitlab \
  --secret-string '{"access_token":"input-your-actual-token"}'

# Bitbucket
aws secretsmanager update-secret \
  --secret-id /pr-reviewer/tokens/bitbucket \
  --secret-string '{"access_token":"input-your-actual-token"}'

# Slack : Slack 알림이 필요한 경우에 설정 합니다.
aws secretsmanager update-secret \
  --secret-id /pr-reviewer/tokens/slack \
  --secret-string '{"access_token":"xoxb-your-actual-token"}'
```

## 저장소 설정

### GitHub
1. 저장소 설정으로 이동
2. Webhooks 메뉴로 이동
3. 새 웹훅 추가:
   - Payload URL: 배포 시 받은 WebhookUrl
   - Content type: application/json
   - Events: Pull requests
   - Active: Yes

### GitLab
1. 저장소 설정으로 이동
2. Webhooks 메뉴로 이동
3. 새 웹훅 추가:
   - URL: 배포 시 받은 WebhookUrl
   - Trigger: Merge request events
   - SSL 검증 활성화

### Bitbucket
1. 저장소 설정으로 이동
2. Webhooks 메뉴로 이동
3. 새 웹훅 추가:
   - URL: 배포 시 받은 WebhookUrl
   - Triggers: Pull Request: Created, Updated

## 사용 방법

봇은 자동으로 다음 작업을 수행합니다:
1. 새로운 PR 또는 기존 PR 업데이트 검토
2. Amazon Bedrock을 사용한 코드 변경 분석
3. PR에 리뷰 코멘트 작성
4. (Option) 설정된 Slack 채널로 요약 전송 (Slack 알림을 사용하려면 Parameter Store의 /pr-reviewer/config/slack_notification 값을 "enable"로 변경하고, Secret Manager의 /pr-reviewer/tokens/slack에 Token을 입력합니다.)

[샘플 Report 보기](https://github.com/muylucir/amazon-bedrock-reviewbot/blob/main/docs/sample_report.md)

## 모니터링

배포에 포함된 모니터링 도구:
- Lambda 함수용 CloudWatch 대시보드
- Step Functions 실행 이력
- API Gateway 로그
- 오류 추적용 사용자 정의 메트릭

AWS 콘솔에서 접근하거나 필요에 따라 추가 알림을 구성할 수 있습니다.

## 커스터마이제이션

### 리뷰 동작 수정

Bedrock 모델 매개변수를 `lib/constructs/secrets-and-parameters.ts`에서 조정:
```typescript
maxTokens: new ssm.StringParameter(this, 'MaxTokens', {
  parameterName: '/pr-reviewer/config/max_tokens',
  stringValue: String(props.maxTokens || 4096),
  description: 'Maximum tokens for model response'
}),
temperature: new ssm.StringParameter(this, 'Temperature', {
  parameterName: '/pr-reviewer/config/temperature',
  stringValue: String(props.temperature || 0.7),
  description: 'Temperature for model response'
})
```

### 리뷰 형식 수정

리뷰 형식은 ProcessChunk Lambda 함수(`src/lambda/process-chunk/index.py`)에서 사용자 정의할 수 있습니다.

### 새로운 기능 추가

모듈식 아키텍처로 새로운 기능을 쉽게 추가할 수 있습니다:
1. `lib/constructs/lambda.ts`에 새 Lambda 함수 추가
2. `lib/constructs/step-functions.ts`에서 Step Functions 워크플로우 수정
3. `lib/constructs/review-bot-role.ts`에서 관련 IAM 역할 업데이트

## 문제 해결

### 일반적인 문제

1. API Gateway 통합 문제:
   - API Gateway 로그 확인
   - IAM 역할과 권한 확인
   - 웹훅 엔드포인트 수동 테스트

2. Step Functions 오류:
   - 실행 이력 확인
   - 상태 머신 입력 형식 확인
   - Lambda 함수 로그 확인

3. Bedrock 통합 문제:
   - Bedrock 접근 권한 확인
   - 리전에서의 모델 사용 가능 여부 확인
   - 모델 매개변수 검토

### 로깅

`lib/constructs/lambda.ts`에서 LOG_LEVEL 환경 변수를 수정하여 상세 로깅 활성화:
```typescript
environment: {
  POWERTOOLS_SERVICE_NAME: 'pr-reviewer',
  LOG_LEVEL: 'DEBUG'  // 더 자세한 로그를 위해 DEBUG로 변경
}
```

## 보안

이 애플리케이션은 다음과 같은 AWS 보안 모범 사례를 따릅니다:
- 최소 권한 IAM 역할
- 시크릿 관리
- 리전별 API 엔드포인트
- CloudWatch 로깅
- 요청 인증

필요에 따라 보안 설정을 검토하고 조정하세요.


## 라이선스

이 프로젝트는 MIT 라이선스를 따릅니다 - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.


---