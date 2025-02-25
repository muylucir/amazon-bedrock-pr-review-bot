import json
import os
from typing import Dict, List, Any, Union
from dataclasses import dataclass
from collections import defaultdict
import boto3
from datetime import datetime

@dataclass
class ReviewSummary:
    total_files: int
    total_primary_files: int
    total_reference_files: int
    total_issues: int
    severity_counts: Dict[str, int]
    category_counts: Dict[str, int]
    critical_issues: List[Dict[str, Any]]
    major_issues: List[Dict[str, Any]]
    suggestions_by_file: Dict[str, List[Dict[str, Any]]]
    reference_context: Dict[str, List[str]]
    # 변경사항 요약
    functional_changes: List[str]
    architectural_changes: List[str]
    technical_improvements: List[str]

class ResultAggregator:
    def __init__(self, event_data: Dict[str, Any]):
        self.ssm = boto3.client('ssm')
        self.event_data = event_data
        self.chunk_results = self._extract_chunk_results()
        self.pr_details = self._extract_pr_details()
        self.secrets = boto3.client('secretsmanager')
        self.config = self._load_config()

    def _load_config(self) -> Dict[str, Any]:
        """Parameter Store에서 설정 로드"""
        config = {}
        try:
            # 기본 설정 로드
            response = self.ssm.get_parameters_by_path(
                Path='/pr-reviewer/config/',
                Recursive=True,
                WithDecryption=True
            )
            
            for param in response['Parameters']:
                # 파라미터 이름에서 마지막 부분만 추출
                name = param['Name'].split('/')[-1]
                config[name] = param['Value']
                   
        except Exception as e:
            print(f"Error loading config: {e}")
            raise

        return config

    def _extract_pr_details(self) -> Dict[str, Any]:
        """PR 상세 정보 추출"""
        try:
            if isinstance(self.event_data, list) and self.event_data:
                # 병렬 처리 결과
                for chunk in self.event_data:
                    if isinstance(chunk, dict) and chunk.get('body'):
                        body = json.loads(chunk['body'])
                        if pr_details := body.get('pr_details'):
                            return pr_details
            elif isinstance(self.event_data, dict):
                # 단일 처리 결과
                if self.event_data.get('body'):
                    body = json.loads(self.event_data['body'])
                    if pr_details := body.get('pr_details'):
                        return pr_details

            return {}
        except Exception as e:
            print(f"Error extracting PR details: {e}")
            return {}

    def _extract_chunk_results(self) -> List[Dict[str, Any]]:
        """청크 결과 추출"""
        results = []
        try:
            if isinstance(self.event_data, list):
                # 병렬 처리 결과
                for chunk in self.event_data:
                    if isinstance(chunk, dict) and chunk.get('body'):
                        body = json.loads(chunk['body'])
                        if chunk_results := body.get('results'):
                            results.extend(chunk_results)
            elif isinstance(self.event_data, dict):
                # 단일 처리 결과
                if self.event_data.get('body'):
                    body = json.loads(self.event_data['body'])
                    if chunk_results := body.get('results'):
                        results.extend(chunk_results)
        except Exception as e:
            print(f"Error extracting chunk results: {e}")

        return results

    def _normalize_line_number(self, line_number: Union[str, int]) -> str:
        """라인 번호 정규화"""
        if isinstance(line_number, str) and line_number.lower() == 'all':
            return 'Throughout file'
        try:
            return str(int(line_number))
        except (ValueError, TypeError):
            return 'N/A'


    def _prepare_summary_prompt(self, changes: Dict[str, List[str]]) -> str:
        """Key Changes Summary 요약을 위한 프롬프트 준비"""
        prompt = """다음 변경사항들을 각 카테고리별로 5문장 이내로 요약해주세요.
        원본 변경사항:

        🔄 Functional Changes:
        """
        for change in changes.get('functional_changes', []):
            prompt += f"- {change}\n"

        prompt += "\n🏗 Architectural Changes:\n"
        for change in changes.get('architectural_changes', []):
            prompt += f"- {change}\n"

        prompt += "\n🔧 Technical Improvements:\n"
        for change in changes.get('technical_improvements', []):
            prompt += f"- {change}\n"

        prompt += """
        위 변경사항들을 다음 형식으로 요약해주세요:

            {
                "summary": {
                    "functional_changes": "2문장 이내의 기능적 변경사항 요약",
                    "architectural_changes": "2문장 이내의 아키텍처 변경사항 요약",
                    "technical_improvements": "2문장 이내의 기술적 개선사항 요약"
                }
            }

            각 요약은 한글로 작성하고, 전문 용어나 고유명사는 원문 그대로 사용해주세요."""
        print(prompt)
        return prompt

    def _summarize_changes_with_bedrock(self, changes: Dict[str, List[str]]) -> Dict[str, str]:
        """Bedrock을 사용하여 변경사항 요약"""
        try:
            bedrock = boto3.client('bedrock-runtime')
            prompt = self._prepare_summary_prompt(changes)

            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1000,
                "temperature": 0.7,
                "top_p": 0.9,
                "system": "2문장 이내로 간결하게 요약하는 전문 리뷰어입니다.",
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            })

            response = bedrock.invoke_model(
                modelId=self.config['model'],
                contentType='application/json',
                accept='application/json',
                body=body.encode()
            )

            response_body = json.loads(response['body'].read())
            summary = json.loads(response_body['content'][0]['text'])
            return summary.get('summary', {})

        except Exception as e:
            print(f"Error summarizing with Bedrock: {e}")
            return {
                'functional_changes': '',
                'architectural_changes': '',
                'technical_improvements': ''
            }

    def analyze_results(self) -> ReviewSummary:
        """리뷰 결과 분석"""
        severity_counts = defaultdict(int)
        category_counts = defaultdict(int)
        critical_issues = []
        major_issues = []
        suggestions_by_file = defaultdict(list)
        reference_context = defaultdict(list)
        total_issues = 0

        # primary/reference 파일 구분
        primary_files = []
        reference_files = []

        for result in self.chunk_results:
            file_path = result['file_path']
            
            if result.get('is_primary', True):
                primary_files.append(file_path)
                severity_counts[result['severity']] += 1
                
                # 참조 파일 정보 저장
                if referenced_by := result.get('referenced_by'):
                    reference_context[file_path].extend(referenced_by)
                
                for suggestion in result.get('suggestions', []):
                    total_issues += 1
                    category = suggestion.get('category', 'other')
                    severity = suggestion.get('severity', 'NORMAL')
                    
                    category_counts[category] += 1
                    
                    # 라인 번호 정규화
                    suggestion['line_number'] = self._normalize_line_number(
                        suggestion.get('line_number')
                    )
                    
                    issue_details = {
                        'file': file_path,
                        'description': suggestion.get('description'),
                        'line_number': suggestion['line_number'],
                        'suggestion': suggestion.get('suggestion')
                    }
                    
                    if severity == 'CRITICAL':
                        critical_issues.append(issue_details)
                    elif severity == 'MAJOR':
                        major_issues.append(issue_details)
                    
                    suggestions_by_file[file_path].append(suggestion)
            else:
                reference_files.append(file_path)

        # 변경사항 요약 수집
        functional_changes = set()
        architectural_changes = set()
        technical_improvements = set()

        for result in self.chunk_results:
            if summary := result.get('summary', {}):
                functional_changes.update(summary.get('functional_changes', []))
                architectural_changes.update(summary.get('architectural_changes', []))
                technical_improvements.update(summary.get('technical_improvements', []))

        return ReviewSummary(
            total_files=len(primary_files) + len(reference_files),
            total_primary_files=len(primary_files),
            total_reference_files=len(reference_files),
            total_issues=total_issues,
            severity_counts=dict(severity_counts),
            category_counts=dict(category_counts),
            critical_issues=critical_issues,
            major_issues=major_issues,
            suggestions_by_file=dict(suggestions_by_file),
            reference_context=dict(reference_context),
            functional_changes=sorted(list(functional_changes)),
            architectural_changes=sorted(list(architectural_changes)),
            technical_improvements=sorted(list(technical_improvements))
        )

    def generate_markdown_report(self, summary: ReviewSummary) -> str:
        pr_title = self.pr_details.get('title', 'Unknown PR')
        pr_author = self.pr_details.get('author', 'Unknown Author')

        report = [
            f"# 🧾 Code Review Report: {pr_title}",
            f"\nGenerated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",

            "\n## Overview",
            f"- Pull Request by: {pr_author}",
            f"- Primary Files Reviewed: {summary.total_primary_files}",
            f"- Reference Files: {summary.total_reference_files}",
            f"- Total Issues Found: {summary.total_issues}",
        ]

        if summary.functional_changes or summary.architectural_changes or summary.technical_improvements:
            # 모든 변경사항 통합
            all_changes = {
                'functional_changes': summary.functional_changes,
                'architectural_changes': summary.architectural_changes,
                'technical_improvements': summary.technical_improvements
            }
        
            # Bedrock을 사용하여 요약
            summarized_changes = self._summarize_changes_with_bedrock(all_changes)

            report.extend([
                "\n## Key Changes Summary",
                "\n### 🔄 Functional Changes",
                summarized_changes.get('functional_changes', ''),
                "\n### 🏗 Architectural Changes",
                summarized_changes.get('architectural_changes', ''),
                "\n### 🔧 Technical Improvements",
                summarized_changes.get('technical_improvements', '')
            ])

        report.extend([
            "\n## Severity Summary",
            "| Severity | Count |",
            "|----------|-------|"
        ])

        # 심각도 요약 테이블
        for severity, count in sorted(summary.severity_counts.items()):
            report.append(f"| {severity} | {count} |")

        # 카테고리 요약 테이블    
        report.extend([
            "\n## Category Summary",
            "| Category | Count |",
            "|----------|-------|"
        ])

        for category, count in sorted(summary.category_counts.items()):
            report.append(f"| {category.title()} | {count} |")

        # 중요 이슈 섹션
        if summary.critical_issues:
            report.append("\n## Critical Issues")
            for issue in summary.critical_issues:
                report.extend([
                    f"\n### {issue['file']} (Line {issue['line_number']})",
                    f"**Issue:** {issue['description']}",
                    f"**Suggestion:** {issue['suggestion']}"
                ])

        if summary.major_issues:
            report.append("\n## Major Issues")
            for issue in summary.major_issues:
                report.extend([
                    f"\n### {issue['file']} (Line {issue['line_number']})",
                    f"**Issue:** {issue['description']}",
                    f"**Suggestion:** {issue['suggestion']}"
                ])

        # 파일별 상세 리뷰
        report.append("\n## Detailed Review by File")
        
        # 모든 이슈를 하나의 테이블로 통합
        report.extend([
            "\n| File | Line | Category | Severity | Description | Suggestion |",
            "|------|------|-----------|-----------|--------------|-------------|"
        ])

        # 모든 파일의 제안사항을 하나의 리스트로 통합
        all_suggestions = []
        for file_path, suggestions in summary.suggestions_by_file.items():
            for suggestion in suggestions:
                all_suggestions.append((file_path, suggestion))

        # 파일명과 라인 번호로 정렬
        sorted_suggestions = sorted(
            all_suggestions,
            key=lambda x: (
                x[0],  # 파일명으로 먼저 정렬
                # 'Throughout file'를 마지막으로
                x[1]['line_number'] == 'Throughout file',
                # 숫자는 숫자순으로
                int(x[1]['line_number']) if x[1]['line_number'].isdigit() else float('inf'),
                # 나머지는 문자열 순으로
                x[1]['line_number']
            )
        )

        # 테이블 생성
        for file_path, suggestion in sorted_suggestions:
            # 마크다운 테이블에서 파이프(|) 문자 이스케이프
            description = suggestion.get('description', 'N/A').replace('|', '\\|')
            suggestion_text = suggestion.get('suggestion', 'N/A').replace('|', '\\|')

            report.append(
                f"| {file_path} | {suggestion['line_number']} | "
                f"{suggestion.get('category', 'Other').title()} | "
                f"{suggestion.get('severity', 'NORMAL')} | "
                f"{description} | "
                f"{suggestion_text} |"
            )

        # 파일 의존성 정보를 별도 섹션으로 분리
        report.append("\n### File Dependencies")
        for file_path, ref_files in sorted(summary.reference_context.items()):
            if ref_files:  # 참조 파일이 있는 경우만 표시
                report.extend([
                    f"\n#### {file_path}",
                    "Related Files:"
                ])
                dedup_ref_files = list(set(ref_files))
                for ref_file in sorted(dedup_ref_files):
                    report.append(f"- {ref_file}")

        # 추가 정보 및 메타데이터
        report.extend([
            "\n## Additional Information",
            "- Review Date: " + datetime.now().strftime('%Y-%m-%d'),
            "- Base Branch: " + self.pr_details.get('base_branch', 'Unknown'),
            "- Head Branch: " + self.pr_details.get('head_branch', 'Unknown'),
            f"- Repository: {self.pr_details.get('repository', 'Unknown')}",
            f"- PR Number: {self.pr_details.get('pr_id', 'Unknown')}"
        ])

        # 리포트 하단에 자동 생성 표시
        report.extend([
            "\n---",
            "🤖 _This report was automatically generated by PR Review Bot & Amazon Bedrock_ 🧾"
        ])

        return '\n'.join(report)

    def prepare_pr_comment(self, summary: ReviewSummary) -> str:
        """PR 코멘트용 요약 생성"""
        comment = [
            "# Code Review Summary",
            f"\nReviewed {summary.total_primary_files} primary files "
            f"(with {summary.total_reference_files} reference files) "
            f"and found {summary.total_issues} issues.",
            
            "\n## Severity Breakdown",
            "| Severity | Count |",
            "|----------|-------|",
        ]
        
        for severity, count in summary.severity_counts.items():
            comment.append(f"| {severity} | {count} |")
        
        if summary.critical_issues:
            comment.append("\n### Critical Issues Found")
            for issue in summary.critical_issues:
                comment.extend([
                    f"\n- **{issue['file']}** (Line {issue['line_number']})",
                    f"  - {issue['description']}",
                    f"  - Suggestion: {issue['suggestion']}"
                ])
        
        if summary.major_issues:
            comment.append("\n### Major Issues Found")
            for issue in summary.major_issues[:5]:  # 상위 5개만 표시
                comment.extend([
                    f"\n- **{issue['file']}** (Line {issue['line_number']})",
                    f"  - {issue['description']}"
                ])
            
            if len(summary.major_issues) > 5:
                comment.append(f"\n... and {len(summary.major_issues) - 5} more major issues.")
        
        return '\n'.join(comment)

    def prepare_slack_message(self, summary: ReviewSummary) -> Dict[str, Any]:
        """Slack 메시지 준비"""
        pr_title = self.pr_details.get('title', 'Unknown PR')
        pr_author = self.pr_details.get('author', 'Unknown Author')
        pr_url = self.pr_details.get('pr_url', '#')

        # PR 제목이 길 경우 축약
        MAX_TITLE_LENGTH = 100
        shortened_title = (pr_title[:MAX_TITLE_LENGTH] + '...') if len(pr_title) > MAX_TITLE_LENGTH else pr_title
        
        severity_emoji = {
            'CRITICAL': '🚨',
            'MAJOR': '⚠️',
            'MINOR': '📝',
            'NORMAL': '✅'
        }
        
        # 전체 심각도 결정
        overall_severity = 'NORMAL'
        if summary.critical_issues:
            overall_severity = 'CRITICAL'
        elif summary.major_issues:
            overall_severity = 'MAJOR'
        elif summary.severity_counts.get('MINOR', 0) > 0:
            overall_severity = 'MINOR'
        
        blocks = [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": f"{severity_emoji[overall_severity]} Review: {shortened_title}"
                }
            },
            {
                "type": "section",
                "fields": [
                    {
                        "type": "mrkdwn",
                        "text": f"*Author:*\n{pr_author}"
                    },
                    {
                        "type": "mrkdwn",
                        "text": f"*Files:*\n{summary.total_primary_files} primary + {summary.total_reference_files} reference"
                    }
                ]
            }
        ]
        
        # 심각도 요약
        severity_text = []
        for severity, count in summary.severity_counts.items():
            if count > 0:
                severity_text.append(f"{severity_emoji[severity]} {severity}: {count}")
        
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "\n".join(severity_text)
            }
        })
        
        # 중요 이슈 하이라이트
        if summary.critical_issues or summary.major_issues:
            highlight_text = ["*Critical/Major Issues:*"]
            
            for issue in (summary.critical_issues + summary.major_issues)[:3]:
                highlight_text.append(
                    f"• {issue['file']} (Line {issue['line_number']}): {issue['description'][:100]}..."
                )
            
            if len(summary.critical_issues + summary.major_issues) > 3:
                remaining = len(summary.critical_issues + summary.major_issues) - 3
                highlight_text.append(f"_...and {remaining} more critical/major issues_")
            
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "\n".join(highlight_text)
                }
            })
        
        # 파일 통계 섹션
        if summary.reference_context:
            file_stats = ["*File Dependencies:*"]
            for primary_file, ref_files in list(summary.reference_context.items())[:3]:
                file_stats.append(f"• `{primary_file}` - {len(ref_files)} related files")
            
            if len(summary.reference_context) > 3:
                remaining = len(summary.reference_context) - 3
                file_stats.append(f"_...and {remaining} more files with dependencies_")
            
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "\n".join(file_stats)
                }
            })
        
        # PR 링크 버튼
        if pr_url and pr_url != '#':
            blocks.append({
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Review PR 👀"
                        },
                        "url": pr_url,
                        "style": "primary"
                    }
                ]
            })
        
        return {
            "blocks": blocks,
            "text": f"Code Review completed for PR: {shortened_title} - Found {summary.total_issues} issues in {summary.total_primary_files} primary files"  # 폴백 텍스트
        }

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Lambda 핸들러"""
    try:

         # 실패 청크 재시도 결과 처리
        classified_results = event.get('classifiedResults', {})
        succeeded_results = classified_results.get('succeeded', [])
        retry_results = event.get('retryResults', [])

        # 모든 결과 병합 (재시도 결과를 성공 결과에 추가)
        all_results = succeeded_results + retry_results

        # 결과 집계기 초기화 - event를 직접 전달
        aggregator = ResultAggregator(all_results)
        summary = aggregator.analyze_results()
        
        markdown_report = aggregator.generate_markdown_report(summary)
        pr_comment = aggregator.prepare_pr_comment(summary)
        slack_message = aggregator.prepare_slack_message(summary)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'summary': {
                    'total_files': summary.total_files,
                    'total_primary_files': summary.total_primary_files,
                    'total_reference_files': summary.total_reference_files,
                    'total_issues': summary.total_issues,
                    'severity_counts': summary.severity_counts,
                    'category_counts': summary.category_counts
                },
                'markdown_report': markdown_report,
                'pr_comment': pr_comment,
                'slack_message': slack_message,
                'pr_details': aggregator.pr_details,
                'reference_context': summary.reference_context
            }, ensure_ascii=False)
        }
        
    except Exception as e:
        print(f"Error aggregating results: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }