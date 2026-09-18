import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { YoutubeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto';

// YouTube category ids documented by Zernio (YouTubePlatformData.categoryId)
export const YOUTUBE_ZERNIO_CATEGORIES = [
  { value: '1', label: 'Film & Animation' },
  { value: '2', label: 'Autos & Vehicles' },
  { value: '10', label: 'Music' },
  { value: '15', label: 'Pets & Animals' },
  { value: '17', label: 'Sports' },
  { value: '20', label: 'Gaming' },
  { value: '22', label: 'People & Blogs' },
  { value: '23', label: 'Comedy' },
  { value: '24', label: 'Entertainment' },
  { value: '25', label: 'News & Politics' },
  { value: '26', label: 'Howto & Style' },
  { value: '27', label: 'Education' },
  { value: '28', label: 'Science & Technology' },
];

// Everything of the YouTube settings, plus the extra fields Zernio supports
export class YoutubeZernioSettingsDto extends YoutubeSettingsDto {
  @IsOptional()
  @IsIn(['', ...YOUTUBE_ZERNIO_CATEGORIES.map((c) => c.value)])
  categoryId?: string;

  @IsOptional()
  @IsString()
  playlistId?: string;

  @IsOptional()
  @IsBoolean()
  containsSyntheticMedia?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  firstComment?: string;
}
