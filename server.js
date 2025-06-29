const express = require('express');
const Parser = require('rss-parser');
const { Client } = require('@notionhq/client');
const OpenAI = require('openai');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const parser = new Parser();

// 환경 변수 설정
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// RSS 피드 목록
const RSS_FEEDS = [
    "https://openai.com/blog/rss.xml",
    "https://www.deepmind.com/blog/rss",
    "https://www.anthropic.com/feed.xml",
    "https://ai.googleblog.com/feeds/posts/default",
    "https://ai.facebook.com/blog/rss/",
    "https://www.microsoft.com/en-us/research/feed/",
    "https://huggingface.co/blog/rss",
    "https://www.eleuther.ai/feed.xml"
];

// Notion 페이지 ID (환경 변수로 설정)
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;

// 이미 처리된 글들을 추적하기 위한 간단한 메모리 저장소
// 실제 운영에서는 데이터베이스나 파일 시스템 사용 권장
let processedArticles = new Set();

// RSS 피드에서 최신 글들 가져오기
async function fetchLatestArticles() {
    const allArticles = [];
    
    for (const feedUrl of RSS_FEEDS) {
        try {
            console.log(`Fetching RSS from: ${feedUrl}`);
            const feed = await parser.parseURL(feedUrl);
            
            // 최근 24시간 내의 글들만 필터링
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            
            const recentArticles = feed.items.filter(item => {
                const pubDate = new Date(item.pubDate || item.isoDate);
                return pubDate > yesterday && !processedArticles.has(item.link);
            }).map(item => ({
                title: item.title,
                link: item.link,
                content: item.contentSnippet || item.content || '',
                source: feed.title || feedUrl,
                pubDate: item.pubDate || item.isoDate,
                summary: item.summary || ''
            }));
            
            allArticles.push(...recentArticles);
            
        } catch (error) {
            console.error(`Error fetching RSS from ${feedUrl}:`, error.message);
        }
    }
    
    return allArticles;
}

// GPT를 사용해 글 요약하기
async function summarizeArticle(article) {
    try {
        const prompt = `
다음 AI 관련 블로그 글을 한국어로 요약해주세요. 핵심 내용과 주요 인사이트를 포함해주세요:

제목: ${article.title}
출처: ${article.source}
내용: ${article.content.substring(0, 2000)}...

요약 형식:
1. 핵심 내용 (2-3문장)
2. 주요 기술/개념
3. 시사점 및 의미

요약은 300자 이내로 작성해주세요.
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500,
            temperature: 0.7
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error summarizing article:', error);
        return `요약 생성 실패: ${article.title}`;
    }
}

// Notion 페이지에 요약 추가
async function addToNotionPage(articles, summaries) {
    try {
        const today = new Date().toLocaleDateString('ko-KR');
        
        // 오늘 날짜로 제목 생성
        const titleBlock = {
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{
                    type: 'text',
                    text: { content: `AI 뉴스 요약 - ${today}` }
                }]
            }
        };

        const blocks = [titleBlock];

        // 각 글의 요약을 블록으로 추가
        articles.forEach((article, index) => {
            // 글 제목
            blocks.push({
                object: 'block',
                type: 'heading_3',
                heading_3: {
                    rich_text: [{
                        type: 'text',
                        text: { content: article.title },
                        annotations: { bold: true }
                    }]
                }
            });

            // 출처와 링크
            blocks.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [
                        {
                            type: 'text',
                            text: { content: `출처: ${article.source} | ` }
                        },
                        {
                            type: 'text',
                            text: { content: '원문 링크', link: { url: article.link } },
                            annotations: { color: 'blue' }
                        }
                    ]
                }
            });

            // 요약 내용
            blocks.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{
                        type: 'text',
                        text: { content: summaries[index] || '요약 없음' }
                    }]
                }
            });

            // 구분선
            blocks.push({
                object: 'block',
                type: 'divider',
                divider: {}
            });
        });

        // Notion 페이지에 블록들 추가
        await notion.blocks.children.append({
            block_id: NOTION_PAGE_ID,
            children: blocks
        });

        console.log(`Successfully added ${articles.length} articles to Notion`);
    } catch (error) {
        console.error('Error adding to Notion:', error);
    }
}

// 메인 처리 함수
async function processAINews() {
    console.log('Starting AI news processing...');
    
    try {
        // 1. 최신 글들 가져오기
        const articles = await fetchLatestArticles();
        console.log(`Found ${articles.length} new articles`);
        
        if (articles.length === 0) {
            console.log('No new articles found');
            return;
        }

        // 2. 각 글 요약하기
        const summaries = [];
        for (const article of articles) {
            console.log(`Summarizing: ${article.title}`);
            const summary = await summarizeArticle(article);
            summaries.push(summary);
            
            // 처리된 글로 마킹
            processedArticles.add(article.link);
            
            // API 호출 제한을 위한 딜레이
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // 3. Notion에 추가
        await addToNotionPage(articles, summaries);
        
        console.log('AI news processing completed successfully');
    } catch (error) {
        console.error('Error in processAINews:', error);
    }
}

// 매일 아침 7시에 실행 (한국 시간 기준)
cron.schedule('0 7 * * *', () => {
    console.log('Running scheduled AI news aggregation at 7 AM KST');
    processAINews();
}, {
    timezone: "Asia/Seoul"
});

// 수동 실행을 위한 엔드포인트
app.get('/run-now', async (req, res) => {
    try {
        await processAINews();
        res.json({ success: true, message: 'AI news processing completed' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 헬스 체크 엔드포인트
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 처리된 글 목록 확인 (디버깅용)
app.get('/processed', (req, res) => {
    res.json({ 
        count: processedArticles.size,
        articles: Array.from(processedArticles)
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AI Blog Aggregator service running on port ${PORT}`);
    console.log('Scheduled to run daily at 7 AM KST');
});

module.exports = app;
