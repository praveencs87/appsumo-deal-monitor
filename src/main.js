import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { URL } from 'url';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { startUrls, maxItems } = input;

    if (!startUrls || startUrls.length === 0) {
        throw new Error('startUrls is required!');
    }

    log.info(`Starting AppSumo Deal Monitor with ${startUrls.length} start URLs.`);

    let extractedCount = 0;
    
    // PPE: Base charge for starting
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxItems ? maxItems * 5 : undefined,
        async requestHandler({ request, $, enqueueLinks, log }) {
            
            // 1. Enqueue more links (Pagination, collections, deals)
            await enqueueLinks({
                strategy: 'same-domain',
                globs: [
                    '**/products/**',
                    '**/collections/**',
                    '**/software/**',
                    '**/?page=*'
                ]
            });

            // 2. Data Extraction
            // We only care about specific deal pages (usually /products/*)
            if (!request.url.includes('/products/')) return;

            let dealData = null;

            // Attempt to parse JSON-LD Schema (AppSumo uses it for SEO)
            const jsonLdScripts = $('script[type="application/ld+json"]').toArray();
            for (const el of jsonLdScripts) {
                try {
                    const content = $(el).html();
                    if (!content) continue;
                    
                    const parsed = JSON.parse(content);
                    const items = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
                    
                    for (const item of items) {
                        if (item['@type'] === 'Product' || item['@type'] === 'SoftwareApplication') {
                            dealData = item;
                            break;
                        }
                    }
                } catch (e) {
                    // Ignore parse errors
                }
                if (dealData) break;
            }

            // Fallback: Check if it's a valid deal page by checking h1
            const h1 = $('h1').first().text().trim();
            if (!dealData && !h1) return; // Not a deal page

            if (maxItems && extractedCount >= maxItems) return;
            
            // Build the record
            let record = {
                url: request.url,
                scrapedAt: new Date().toISOString()
            };

            if (dealData) {
                // Map from JSON-LD
                record.name = dealData.name || h1;
                record.description = dealData.description || $('meta[name="description"]').attr('content');
                record.image = dealData.image;
                
                if (dealData.aggregateRating) {
                    record.ratingValue = dealData.aggregateRating.ratingValue;
                    record.reviewCount = dealData.aggregateRating.reviewCount;
                }
                
                if (dealData.offers) {
                    const offers = Array.isArray(dealData.offers) ? dealData.offers[0] : dealData.offers;
                    record.price = offers.price;
                    record.currency = offers.priceCurrency;
                    record.availability = offers.availability ? offers.availability.split('/').pop() : undefined;
                }
            } else {
                // Map from standard HTML selectors
                record.name = h1;
                record.description = $('meta[name="description"]').attr('content');
                
                // AppSumo typically uses large price tags
                const priceMatch = $('body').text().match(/\$([0-9,.]+)/);
                if (priceMatch) {
                    record.price = priceMatch[1];
                    record.currency = 'USD';
                }
            }
            
            // Push to dataset
            await Actor.pushData(record);
            
            // PPE: Charge per deal extracted
            await Actor.charge({ eventName: 'deal-extracted', count: 1 });
            
            extractedCount++;
            log.info(`🌮 Extracted deal: ${record.name} (${extractedCount}${maxItems ? `/${maxItems}` : ''})`);
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Request ${request.url} failed too many times.`);
        },
    });

    const initialRequests = startUrls.map(req => ({ url: typeof req === 'string' ? req : req.url }));
    await crawler.addRequests(initialRequests);
    
    await crawler.run();

    log.info(`🎉 Successfully scraped ${extractedCount} deals!`);
} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
