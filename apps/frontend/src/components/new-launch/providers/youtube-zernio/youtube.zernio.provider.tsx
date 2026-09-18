'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import {
  YOUTUBE_ZERNIO_CATEGORIES,
  YoutubeZernioSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.zernio.settings.dto';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { MediumTags } from '@gitroom/frontend/components/new-launch/providers/medium/medium.tags';
import { MediaComponent } from '@gitroom/frontend/components/media/media.component';
import { Select } from '@gitroom/react/form/select';
import { YoutubePreview } from '@gitroom/frontend/components/new-launch/providers/youtube/youtube.preview';
import { YoutubeZernioPlaylist } from '@gitroom/frontend/components/new-launch/providers/youtube-zernio/youtube.zernio.playlist';

const type = [
  {
    label: 'Public',
    value: 'public',
  },
  {
    label: 'Private',
    value: 'private',
  },
  {
    label: 'Unlisted',
    value: 'unlisted',
  },
];

const madeForKids = [
  {
    label: 'No',
    value: 'no',
  },
  {
    label: 'Yes',
    value: 'yes',
  },
];

// Same fields as the YouTube provider, plus the options Zernio supports
const YoutubeZernioSettings: FC = () => {
  const { register } = useSettings();
  return (
    <div className="flex flex-col">
      <Input label="Title" {...register('title')} maxLength={100} />
      <Select
        label="Type"
        {...register('type', {
          value: 'public',
        })}
      >
        {type.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <Select
        label="Made for kids"
        {...register('selfDeclaredMadeForKids', {
          value: 'no',
        })}
      >
        {madeForKids.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <Select label="Category" {...register('categoryId')}>
        <option value="">People & Blogs (default)</option>
        {YOUTUBE_ZERNIO_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
      <YoutubeZernioPlaylist {...register('playlistId')} />
      <MediumTags label="Tags" {...register('tags')} />
      <div className="mt-[10px]">
        <Checkbox
          variant="hollow"
          label="Contains AI-generated / altered content (synthetic media)"
          {...register('containsSyntheticMedia', {
            value: false,
          })}
        />
      </div>
      <div className="mt-[20px]">
        <Textarea
          label="First comment (optional)"
          maxLength={10000}
          {...register('firstComment')}
        />
      </div>
      <div className="mt-[20px]">
        <MediaComponent
          type="image"
          width={1280}
          height={720}
          label="Thumbnail"
          description="Thumbnail picture (optional)"
          {...register('thumbnail')}
        />
      </div>
    </div>
  );
};
export default withProvider({
  postComment: PostComment.COMMENT,
  comments: false,
  minimumCharacters: [],
  SettingsComponent: YoutubeZernioSettings,
  CustomPreviewComponent: YoutubePreview,
  dto: YoutubeZernioSettingsDto,
  maximumCharacters: 5000,
});
