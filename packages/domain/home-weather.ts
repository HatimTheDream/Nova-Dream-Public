import { z } from 'zod';

export const homeWeatherTimezoneSchema = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a valid timezone.');
export const homeWeatherLocationSchema = z.object({
  name: z.string().trim().min(1).max(120), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), timezone: homeWeatherTimezoneSchema,
}).strict();
export const homeWeatherUnitsSchema = z.enum(['celsius', 'fahrenheit']);
export const homeWeatherForecastSchema = z.object({
  temperature: z.number().min(-150).max(180), weatherCode: z.number().int().min(0).max(99),
  high: z.number().min(-150).max(180).nullable(), low: z.number().min(-150).max(180).nullable(), precipitationProbability: z.number().min(0).max(100).nullable(),
}).strict().refine(value => value.high === null || value.low === null || value.high >= value.low, 'Invalid daily temperature range.');
export const homeWeatherResultSchema = z.object({
  widgetId: z.string().max(100), location: homeWeatherLocationSchema.nullable(), units: homeWeatherUnitsSchema,
  forecast: homeWeatherForecastSchema.nullable(), fetchedAt: z.iso.datetime().nullable(), dataTime: z.iso.datetime().nullable(), stale: z.boolean(), error: z.string().max(200).optional(),
}).strict();
export const homeWeatherLocationsSchema = z.object({ locations: z.array(homeWeatherLocationSchema).max(5), attribution: z.literal('GeoNames') }).strict();
export type HomeWeatherLocation = z.infer<typeof homeWeatherLocationSchema>;
export type HomeWeatherForecast = z.infer<typeof homeWeatherForecastSchema>;
export type HomeWeatherResult = z.infer<typeof homeWeatherResultSchema>;
export type HomeWeatherLocations = z.infer<typeof homeWeatherLocationsSchema>;
export type HomeWeatherUnits = z.infer<typeof homeWeatherUnitsSchema>;
